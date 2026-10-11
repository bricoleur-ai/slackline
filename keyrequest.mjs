// Slack-mediated key request/approval flow: a machine/agent with no key yet asks for one over
// plain unauthenticated HTTP; the configured approver gets a Slack DM and has to reply inside
// that same DM to approve or deny; only then is a real key minted. See docs/keys.md for the wire
// contract, the abuse-surface analysis, and the DM-exposure tradeoff this design accepts.
//
// SECURITY, mirroring the contract keys.mjs sets for itself (see that file's header):
//   - No key is EVER minted except from inside handleDecision(), and only after
//     store.claimKeyRequestApproval() atomically flips a row from 'pending' to 'approved' —
//     that atomic claim (not a check-then-act) is what makes duplicate/racing approve replies
//     idempotent (never two keys for one request).
//   - The `key_requests` row never holds raw key material — only poll_hash (sha256 of the poll
//     token, itself not Slack-facing secret material but treated the same way on principle) and,
//     once approved, key_id (the key's PUBLIC id, for audit/revocation — never its secret half).
//   - The one raw key this flow ever produces lives only in `delivery`, an in-process Map, from
//     the moment createKey() returns until the requester's first successful poll collects it (or
//     a GC timer drops it). It is never logged and never written to the store.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createKey, normalizeOrgs } from './keys.mjs';
import { api as slackApi } from './slack.mjs';

function sha256hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const REQUEST_ID_BYTES = 12;   // 24 hex chars — public, rides in the poll URL
const POLL_TOKEN_BYTES = 24;   // 48 hex chars (192 bits) — the actual poll capability, unguessable
// No 0/O/1/I/L: an approver retyping this off a phone notification shouldn't have to squint.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
function randomCode() {
  const bytes = randomBytes(CODE_LEN);
  let s = ''; for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
// Matches a bare 6-char code anywhere in the approver's reply text (case-insensitive) plus a
// separate approve/deny intent word — deliberately two independent regexes rather than one
// "approve <code>" pattern, so word order/extra chatter ("approve please, ABC123!") still works.
const CODE_RE = /\b([A-HJ-NP-Z2-9]{6})\b/i;
const APPROVE_RE = /\b(approve|approved|yes|y)\b/i;
const DENY_RE = /\b(deny|denied|no|n|reject|rejected)\b/i;

// label/requester come from an UNAUTHENTICATED caller (see file header) and get interpolated
// into the approver's DM text — escape Slack mrkdwn-significant characters the way Slack's own
// docs specify, so a crafted label can't fake a link or an @mention inside that message.
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const DEFAULTS = {
  ttlMs: 10 * 60 * 1000,          // a request not decided within this window can never be approved
  messageTtlMs: 5 * 60 * 1000,    // how long the delivered-key DM stays before self-deleting
  maxPending: 25,                  // hub-wide concurrent pending cap — bounds worst-case DM spam
  rateLimitMax: 5,                 // requests...
  rateLimitWindowMs: 10 * 60 * 1000, // ...per this window, per source address
};

export function createKeyRequestManager({ store, bus, credsMap, config = {}, log = () => {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const delivery = new Map();   // request_id -> { key } — see file header; GC'd by a timer, below
  const hits = new Map();       // rate limiter: address -> { count, windowStart } (fixed window)
  let dmChannel = null;         // resolved once on first request, reused — one DM, many requests

  const configured = () => !!(cfg.approver && cfg.approverOrg);

  // Fixed-window limiter: good enough to bound worst-case volume (the actual point — see
  // docs/keys.md) without a dependency or a sorted-timestamp structure. A burst can land up to
  // ~2x rateLimitMax across a window boundary; that's an accepted slack, not a bypass.
  function rateLimited(addr) {
    const now = Date.now();
    const h = hits.get(addr);
    if (!h || now - h.windowStart > cfg.rateLimitWindowMs) { hits.set(addr, { count: 1, windowStart: now }); return false; }
    h.count++;
    return h.count > cfg.rateLimitMax;
  }

  async function resolveDmChannel(creds) {
    if (dmChannel) return dmChannel;
    const r = await slackApi(creds, 'conversations.open', { users: cfg.approver });
    if (!r.ok) throw new Error(`could not open a DM with the approver: ${r.error}`);
    dmChannel = r.channel.id;
    return dmChannel;
  }

  // ---- POST /keys/request -----------------------------------------------------------------
  async function requestKey(body, meta = {}) {
    if (!configured()) return { status: 503, body: { error: 'key requests are not configured on this hub' } };
    const creds = credsMap.get(cfg.approverOrg);
    if (!creds) return { status: 503, body: { error: `approver org '${cfg.approverOrg}' has no live Slack credentials` } };

    // Rate limit first — cheapest check, and the one that actually bounds an attacker hammering
    // this deliberately-unauthenticated route (item 3 in the design brief).
    const addr = meta.ip || 'unknown';
    if (rateLimited(addr)) return { status: 429, body: { error: 'too many key requests from this address, try again later' } };

    const label = String(body?.label ?? '').trim().slice(0, 200);
    if (!label) return { status: 400, body: { error: 'label is required' } };
    let orgs;
    try { orgs = normalizeOrgs(body?.orgs); } catch (e) { return { status: 400, body: { error: e.message } }; }
    // Reject org names the hub doesn't actually have — keeps a probing/garbage request from ever
    // reaching the approver as a DM at all, tightening the abuse surface further.
    if (orgs !== '*') for (const o of orgs.split(',')) if (!credsMap.has(o)) return { status: 400, body: { error: `unknown org: ${o}` } };
    const requester = String(body?.requester ?? '').trim().slice(0, 200);

    // Pending cap: the hard bound on worst-case DM volume. Expired-but-not-yet-lazily-flipped
    // rows don't count (countPendingKeyRequests filters on expires_at), so a flood of never-
    // decided requests self-drains once they age past ttlMs instead of permanently exhausting it.
    if ((await store.countPendingKeyRequests()) >= cfg.maxPending) {
      return { status: 429, body: { error: 'too many pending key requests right now, try again later' } };
    }

    let channel;
    try { channel = await resolveDmChannel(creds); }
    catch (e) { log(`key-request: ${e.message}`); return { status: 502, body: { error: 'could not reach the approver on Slack' } }; }

    const id = randomBytes(REQUEST_ID_BYTES).toString('hex');
    const pollToken = randomBytes(POLL_TOKEN_BYTES).toString('hex');
    const code = randomCode();
    const created = Date.now();
    const expires_at = created + cfg.ttlMs;
    const mins = Math.max(1, Math.round(cfg.ttlMs / 60000));

    const text = `:key: *Key request* \`${code}\`\n`
      + `*Label:* ${esc(label)}\n*Orgs:* ${esc(orgs)}\n*Requester:* ${esc(requester || '(none given)')}\n`
      + `Expires in ~${mins} min.\n\nReply \`approve ${code}\` to approve, or \`deny ${code}\` to deny.`;
    const posted = await slackApi(creds, 'chat.postMessage', { channel, text });
    if (!posted.ok) { log(`key-request: failed to DM approver: ${posted.error}`); return { status: 502, body: { error: 'could not notify the approver on Slack' } }; }

    // Persisted row holds a hash of the poll token and nothing else secret — see file header.
    await store.putKeyRequest({ id, poll_hash: sha256hex(pollToken), code, label, orgs, requester,
      status: 'pending', created, expires_at, approver_org: cfg.approverOrg, dm_channel: channel });
    log(`key-request ${id} (${code}) opened: label="${label}" orgs=${orgs}`);
    return { status: 200, body: { request_id: id, poll_token: pollToken, code, expires_at } };
  }

  // ---- GET /keys/request/<id>?token=... ----------------------------------------------------
  async function pollRequest(id, token) {
    const row = await store.getKeyRequest(id);
    if (!row) return { status: 404, body: { error: 'not found' } };
    if (!safeEq(sha256hex(String(token || '')), row.poll_hash)) return { status: 401, body: { error: 'invalid token' } };

    if (row.status === 'pending' && Date.now() > row.expires_at) {
      await store.expireKeyRequest(id);
      delivery.delete(id);
      return { status: 200, body: { status: 'expired' } };
    }
    if (row.status !== 'approved') return { status: 200, body: { status: row.status } };

    // markKeyRequestDelivered is itself the atomic single-use gate: under two concurrent polls
    // only one flips delivered false->true and only that one gets the key (item 4).
    const held = delivery.get(id);
    if (held && (await store.markKeyRequestDelivered(id))) {
      delivery.delete(id);
      return { status: 200, body: { status: 'approved', key: held.key } };
    }
    return { status: 200, body: { status: 'approved' } };
  }

  // ---- approver reply handling (fed by the bus 'event' listener, below) --------------------
  async function handleDecision(code, decision, approverUserId) {
    const row = await store.getPendingKeyRequestByCode(code);
    if (!row) return;   // unknown / already-resolved code — nothing to act on
    if (Date.now() > row.expires_at) { await store.expireKeyRequest(row.id); return; }   // item 5

    if (decision === 'denied') {
      // WHERE status='pending' inside denyKeyRequest makes this idempotent the same way approval
      // is below — a second "deny" reply just finds nothing left to claim.
      if (!(await store.denyKeyRequest(row.id, { decided_by: approverUserId, decided_at: Date.now() }))) return;
      slackApi(credsMap.get(row.approver_org), 'chat.postMessage',
        { channel: row.dm_channel, text: `Denied \`${code}\` (${esc(row.label)}).` }).catch(() => {});
      return;
    }

    // Atomic claim BEFORE ever calling createKey() — the whole idempotency guarantee (item 8)
    // rests on this being the one operation that decides who, if anyone, gets to mint a key.
    const claimed = await store.claimKeyRequestApproval(row.id, { decided_by: approverUserId, decided_at: Date.now() });
    if (!claimed) return;   // a previous reply already decided this request

    const creds = credsMap.get(row.approver_org);
    let created;
    try { created = await createKey(store, { label: row.label, orgs: row.orgs }); }   // the ONLY function that ever returns raw key material
    catch (e) {
      log(`key-request ${row.id}: createKey failed: ${e.message}`);
      await store.revertKeyRequestToPending(row.id);   // self-heals: the approver can just reply again
      return;
    }
    await store.setKeyRequestKeyId(row.id, created.id);   // public id only, for audit/revocation
    delivery.set(row.id, { key: created.key });
    // Safety-net GC for a request that's approved but never polled (crash, abandoned agent, …) —
    // without this the raw key would sit in `delivery` for the life of the process.
    const gc = setTimeout(() => delivery.delete(row.id), Math.max(cfg.messageTtlMs, cfg.ttlMs) + 15 * 60 * 1000);
    gc.unref?.();

    const mins = Math.max(1, Math.round(cfg.messageTtlMs / 60000));
    const warn = `:white_check_mark: Approved \`${code}\`. Key for *${esc(row.label)}*:\n\`\`\`${created.key}\`\`\`\n`
      + `Save this now — this message self-deletes in ~${mins} min and slackline never shows it again.`;
    const posted = await slackApi(creds, 'chat.postMessage', { channel: row.dm_channel, text: warn });
    if (posted.ok && posted.ts) {
      const t = setTimeout(() => { slackApi(creds, 'chat.delete', { channel: row.dm_channel, ts: posted.ts }).catch(() => {}); }, cfg.messageTtlMs);
      t.unref?.();
    }
  }

  // Reuses the hub's existing ingest -> store -> bus pipeline instead of a second Slack
  // listener: whatever identity is running for cfg.approverOrg already streams every message it
  // receives through this same 'event' bus (see api.mjs's /tail route for the established
  // pattern). Works for either credential mode here specifically because the DM in question is
  // always one WE open (resolveDmChannel, above) before expecting a reply — app mode only sees
  // DMs it's a party to, but it IS a party to this one; user mode sees it too, as a subset of
  // "all its own DMs". See docs/keys.md for the fuller writeup.
  bus.on('event', (rec) => {
    if (!configured() || !dmChannel) return;      // nothing could be pending before a channel exists
    if (rec.type) return;                          // reaction/edit/delete signal, not a chat message
    if (rec.org !== cfg.approverOrg || rec.channel !== dmChannel) return;
    if (rec.user !== cfg.approver) return;          // verify by Slack USER ID — never display name (item 2)
    const codeM = CODE_RE.exec(rec.text || '');
    if (!codeM) return;
    const decision = APPROVE_RE.test(rec.text) ? 'approved' : DENY_RE.test(rec.text) ? 'denied' : null;
    if (!decision) return;
    handleDecision(codeM[1].toUpperCase(), decision, rec.user).catch((e) => log(`key-request: decision handling failed: ${e.message}`));
  });

  return { requestKey, pollRequest };
}
