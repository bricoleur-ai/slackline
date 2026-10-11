import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { installPage } from './page.mjs';
import { transcript, shape, channelLabel, nameFor } from './render.mjs';
import { hydrateThread, ensureNames, hydrateAround, backfillChannel, api as slackApi } from './slack.mjs';
import { badgeFor } from './badge.mjs';
import { verifyAndPersist } from './app.mjs';
import { verifyKey, scopeAllows, safeEqual } from './keys.mjs';
import { createKeyRequestManager } from './keyrequest.mjs';

// live-tail filter (per-subscriber, via query params)
function tailMatch(rec, f, selfId) {
  if (f.channels && !f.channels.includes(rec.channel)) return false;
  if (f.user && rec.user !== f.user) return false;
  if (f.mentions && selfId && !(rec.text || '').includes('<@' + selfId + '>')) return false;
  if (f.keywords && !f.keywords.some(k => (rec.text || '').toLowerCase().includes(k))) return false;
  return true;
}

export function startApi(store, bus, credsMap, opts = {}) {
  const PORT = opts.port || 8790;
  const SECRET = opts.secret || '';
  const onToken = opts.onToken || (() => {});
  const onApp = opts.onApp || (() => {});
  const soleOrg = () => (credsMap.size === 1 ? [...credsMap.keys()][0] : null);

  // Slack-mediated key request/approval (keyrequest.mjs). Config can be injected via opts
  // (tests, and any future caller) or falls back to process.env — standalone.mjs/server.mjs
  // already run this code in-process, so setting SLACKLINE_KEY_* in their environment is enough
  // to pick this up with no changes to either of those files.
  const keyRequests = createKeyRequestManager({
    store, bus, credsMap, log: (m) => bus.emit('log', m),
    config: {
      approver: opts.keyApprover ?? process.env.SLACKLINE_KEY_APPROVER ?? '',
      approverOrg: opts.keyApproverOrg ?? process.env.SLACKLINE_KEY_APPROVER_ORG ?? '',
      ttlMs: +(opts.keyRequestTtlMs ?? process.env.SLACKLINE_KEY_REQUEST_TTL_MS ?? 10 * 60 * 1000),
      messageTtlMs: +(opts.keyMessageTtlMs ?? process.env.SLACKLINE_KEY_MESSAGE_TTL_MS ?? 5 * 60 * 1000),
      maxPending: +(opts.keyRequestMaxPending ?? process.env.SLACKLINE_KEY_REQUEST_MAX_PENDING ?? 25),
      rateLimitMax: +(opts.keyRequestRateMax ?? process.env.SLACKLINE_KEY_REQUEST_RATE_MAX ?? 5),
      rateLimitWindowMs: +(opts.keyRequestRateWindowMs ?? process.env.SLACKLINE_KEY_REQUEST_RATE_WINDOW_MS ?? 10 * 60 * 1000),
    },
  });

  // Resolves a request to an org "scope": '*' means unrestricted (loopback, a matching
  // SLACKLINE_SECRET, or a wildcard-scoped key — all trusted the same amount), an array means
  // "only these orgs", null means unauthenticated. Loopback is checked first and short-circuits
  // exactly as before a key existed — this is the "loopback exemption stays as-is" contract:
  // a request from 127.0.0.1/::1 is always fully trusted, full stop, regardless of headers.
  const authScope = async (req, url) => {
    const ra = req.socket.remoteAddress || '';
    if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return '*';
    const givenSecret = req.headers['x-slackline-secret'] || url.searchParams.get('secret');
    if (SECRET && safeEqual(givenSecret, SECRET)) return '*';   // master credential: unrestricted
    const givenKey = req.headers['x-slackline-key'] || url.searchParams.get('key');
    if (givenKey) {
      const row = await verifyKey(store, givenKey);   // null for unknown/revoked/wrong-hash alike
      if (row) return row.orgs;
    }
    return null;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const org = url.searchParams.get('org') || soleOrg();
    const inclDel = url.searchParams.get('include_deleted') === '1';
    try {
      // ---- public bootstrap routes (no secret needed) ----
      if (p === '/' || p === '/install') {
        const base = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || ('localhost:' + PORT));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(installPage(base));
      }
      if (p.startsWith('/packages/')) {
        const name = p.slice('/packages/'.length);
        if (!/^slackline-collector-(macos|linux|windows)\.zip$/.test(name)) return json(res, 404, { error: 'no such package' });
        const fp = fileURLToPath(new URL('./packages/dist/' + name, import.meta.url));
        if (!existsSync(fp)) return json(res, 404, { error: 'package not built' });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"` });
        return res.end(readFileSync(fp));
      }

      // ---- Slack-mediated key request/approval — deliberately unauthenticated (see
      // keyrequest.mjs's file header for the abuse-surface analysis: rate limiting + a pending
      // cap bound it instead, and no key is EVER issued without the configured approver's own
      // Slack reply). Kept above authScope on purpose, same as the routes just above.
      if (p === '/keys/request' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c;
        let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
        const r = await keyRequests.requestKey(b, { ip: req.socket.remoteAddress || 'unknown' });
        return json(res, r.status, r.body);
      }
      if (p.startsWith('/keys/request/') && req.method === 'GET') {
        const r = await keyRequests.pollRequest(p.slice('/keys/request/'.length), url.searchParams.get('token'));
        return json(res, r.status, r.body);
      }

      const scope = await authScope(req, url);
      if (scope === null) return json(res, 401, { error: 'unauthorized' });
      // A key scoped to e.g. 'acme' asking for a different org must get a loud 403, not a
      // quiet empty result — an empty /query looks exactly like "no messages matched" and would
      // hide a misconfigured key from the operator. Only fires once a route has resolved a
      // concrete org (scopeAllows lets a still-null org through to that route's own handling).
      const forbidden = (o) => !!o && !scopeAllows(scope, o);

      if (p === '/health') return json(res, 200, { ok: true, ...(await store.stats()), orgs_live: [...credsMap.keys()] });

      // ---- live tail: NDJSON stream (curl -N / Monitor) ----
      if (p === '/tail') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const f = {
          channels: url.searchParams.get('channels')?.split(',').filter(Boolean),
          user: url.searchParams.get('user') || null,
          mentions: url.searchParams.get('mentions') === '1',
          keywords: url.searchParams.get('keywords')?.split(',').map(s => s.toLowerCase()).filter(Boolean),
          origins: url.searchParams.get('origin')?.split(',').filter(Boolean),        // e.g. human,peer
          types: url.searchParams.get('types')?.split(',').filter(Boolean),           // e.g. message,reaction_added
        };
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', connection: 'keep-alive' });
        // Node buffers headers until the first res.write() — without an explicit flush, a
        // channel-scoped tail with no traffic yet leaves the client waiting on nothing (not even
        // headers), and looks identical to a hung connection. Send them the moment the client is
        // authorized, independent of when/whether the first event or keepalive lands.
        res.flushHeaders();
        // app creds carry bot_user_id, not user_id — without this fallback selfId is
        // undefined for app-mode orgs, which skips the mentions predicate entirely (fail open).
        const selfId = credsMap.get(org)?.user_id ?? credsMap.get(org)?.bot_user_id;
        const since = url.searchParams.get('since');
        if (since && f.channels) {          // gap-fill on reconnect: replay stored msgs since a ts, then go live
          for (const row of await store.since(org, f.channels, since, 1000)) {
            if (f.origins && !f.origins.includes(row.origin || 'peer')) continue;
            if (tailMatch(row, f, selfId)) res.write(JSON.stringify(await shape(store, row.org, row, { includeDeleted: inclDel })) + '\n');
          }
        }
        const onEv = async (rec) => {
          // Belt-and-braces beyond the upfront forbidden(org) check above: when no ?org= was
          // given (multi-org hub, org resolves to null), the `org &&` clause right below never
          // fires, so without this a scoped key would see every org's live events fly by — the
          // one case forbidden() can't catch because there's no single org to reject upfront.
          if (!scopeAllows(scope, rec.org)) return;
          if (org && rec.org !== org) return;
          if (f.channels && !f.channels.includes(rec.channel)) return;
          if (rec.type) {
            if (f.types && !f.types.includes(rec.type)) return;
            const base = { type: rec.type, channel: rec.channel,
              channel_name: await channelLabel(store, rec.org, rec.channel), ts: rec.ts, time: rec.time };
            if (rec.type === 'message_edited') base.text = rec.text;
            if (rec.type === 'reaction_added' || rec.type === 'reaction_removed') {
              base.emoji = rec.emoji; base.user = rec.user; base.user_name = await nameFor(store, rec.org, rec.user);
            }
            res.write(JSON.stringify(base) + '\n');
            return;
          }
          if (f.types && !f.types.includes('message')) return;
          if (f.origins && !f.origins.includes(rec.origin || 'peer')) return;
          if (!tailMatch(rec, f, selfId)) return;
          res.write(JSON.stringify(await shape(store, rec.org, rec)) + '\n');
        };
        bus.on('event', onEv);
        // A blank line, not '' — writing an empty string is a no-op in Node's http module (no
        // bytes hit the wire), so this "keepalive" never actually kept anything alive; NDJSON
        // consumers already treat a blank line as a ping (see remote.mjs's _consume).
        const ka = setInterval(() => res.write('\n'), 25000);
        req.on('close', () => { bus.off('event', onEv); clearInterval(ka); });
        return;
      }

      // ---- query: text search ----
      if (p === '/query') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const q = url.searchParams.get('q') || '';
        const limit = Math.min(+url.searchParams.get('limit') || 30, 200);
        let rows = q ? await store.search(org, q, limit) : [];
        if (!inclDel) rows = rows.filter(r => !r.deleted);
        await ensureNames(store, org, credsMap.get(org), rows);
        return json(res, 200, { org, q, count: rows.length, results: await Promise.all(rows.map(m => shape(store, org, m, { includeDeleted: inclDel }))) });
      }

      // ---- recent channel history ----
      if (p === '/recent') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const channel = url.searchParams.get('channel');
        const limit = Math.min(+url.searchParams.get('limit') || 20, 200);
        const creds = credsMap.get(org);
        let rows = await store.recent(org, channel, limit);
        // Self-heal: the rolling store only ever fills from live traffic — a channel slackline
        // hasn't seen anything on yet would answer "nothing stored", even though the messages
        // plainly exist in Slack. One backfilled page (slack.mjs's backfillChannel) turns that
        // into a real answer instead of a dead end. not_in_channel is reported in-body (below)
        // rather than as a non-2xx, so it's the single case worth naming to the caller plainly —
        // it's the single most likely cause and is fixable by the operator in ten seconds.
        let notInChannel = false;
        if (!rows.length && creds) {
          const bf = await backfillChannel(store, org, creds, channel, { limit, pages: 1, blobRoot: opts.blobRoot }).catch(() => null);
          if (bf && bf.error === 'not_in_channel') notInChannel = true;
          else rows = await store.recent(org, channel, limit);
        }
        await ensureNames(store, org, creds, rows);
        return json(res, 200, { org, channel: await channelLabel(store, org, channel),
          ...(notInChannel ? { error: 'not_in_channel' } : {}),
          transcript: await transcript(store, org, rows, { includeDeleted: inclDel }), messages: await Promise.all(rows.map(m => shape(store, org, m, { includeDeleted: inclDel }))) });
      }

      // ---- channel history backfill: the "look back" /recent and /query never had — pages
      // conversations.history directly (no ts anchor needed, unlike /thread and /context below)
      // and stores the result the same way live ingest does, then answers like /recent. oldest/
      // latest bound how far back to fetch; the returned transcript is built straight from what
      // this call fetched (not store.recent afterward), so a caller asking for an old window
      // gets that window even if the channel also has newer live traffic already stored.
      if (p === '/history') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const channel = url.searchParams.get('channel');
        const creds = credsMap.get(org);
        if (!creds) return json(res, 400, { error: 'unknown org' });
        const limit = Math.min(+url.searchParams.get('limit') || 100, 1000);
        const pages = Math.min(+url.searchParams.get('pages') || 5, 20);
        const oldest = url.searchParams.get('oldest') || undefined;
        const latest = url.searchParams.get('latest') || undefined;
        const bf = await backfillChannel(store, org, creds, channel, { limit, oldest, latest, pages, blobRoot: opts.blobRoot });
        await ensureNames(store, org, creds, bf.messages);
        return json(res, 200, { org, channel: await channelLabel(store, org, channel),
          fetched: bf.fetched, stored: bf.stored, oldest_ts: bf.oldest_ts, has_more: bf.has_more,
          ...(bf.error ? { error: bf.error } : {}),
          transcript: await transcript(store, org, bf.messages, { includeDeleted: inclDel }),
          messages: await Promise.all(bf.messages.map(m => shape(store, org, m, { includeDeleted: inclDel }))) });
      }

      // ---- full thread (hydrate on demand) ----
      if (p === '/thread') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const channel = url.searchParams.get('channel');
        const thread_ts = url.searchParams.get('thread_ts');
        const creds = credsMap.get(org);
        if (creds) await hydrateThread(store, org, creds, channel, thread_ts, opts.blobRoot).catch(() => {});
        const rows = await store.thread(org, channel, thread_ts);
        await ensureNames(store, org, credsMap.get(org), rows);
        return json(res, 200, { org, channel: await channelLabel(store, org, channel), thread_ts,
          transcript: await transcript(store, org, rows, { includeDeleted: inclDel }), messages: await Promise.all(rows.map(m => shape(store, org, m, { includeDeleted: inclDel }))) });
      }

      // ---- context bundle: thread (if any) + surrounding snippet + participants ----
      if (p === '/context') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        const channel = url.searchParams.get('channel');
        const ts = url.searchParams.get('ts');
        const creds = credsMap.get(org);
        let target = await store.getMessage(org, channel, ts);
        if (!target && creds) { await hydrateAround(store, org, creds, channel, ts).catch(() => {}); target = await store.getMessage(org, channel, ts); }
        const root = target ? target.thread_ts : ts;
        if (creds) await hydrateThread(store, org, creds, channel, root, opts.blobRoot).catch(() => {});
        const threadRows = await store.thread(org, channel, root);
        let rows, mode;
        if (threadRows.length > 1) { rows = threadRows; mode = 'thread'; }
        else { rows = await store.around(org, channel, ts, 6, 3); mode = 'snippet'; }
        await ensureNames(store, org, creds, rows);
        const participants = [...new Set(rows.map(m => m.user))];
        const who = {};
        for (const u of participants) { const usr = await store.getUser(org, u); who[u] = usr ? (usr.display_name || usr.real_name || usr.name) : u; }
        return json(res, 200, {
          org, channel: await channelLabel(store, org, channel), ts, mode,
          participants: who,
          transcript: await transcript(store, org, rows, { includeDeleted: inclDel }),
          messages: await Promise.all(rows.map(m => shape(store, org, m, { includeDeleted: inclDel }))),
        });
      }

      if (p === '/user') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        return json(res, 200, await store.getUser(org, url.searchParams.get('id')) || {});
      }
      if (p === '/channel') {
        if (forbidden(org)) return json(res, 403, { error: 'org not in key scope' });
        return json(res, 200, await store.getChannel(org, url.searchParams.get('id')) || {});
      }

      // ---- serve an archived attachment ----
      if (p === '/file') {
        const rel = url.searchParams.get('rel') || '';
        if (!rel || rel.includes('..') || !/^[\w./-]+$/.test(rel)) return json(res, 400, { error: 'bad path' });
        // Attachments are archived under blobRoot/<org>/<channel>/<date>/<file> (slack.mjs's
        // archiveFiles) — `rel` isn't org-tagged by a query param like the other routes, so the
        // org has to be pulled out of the path itself to scope this the same as everything else.
        if (forbidden(rel.split('/')[0])) return json(res, 403, { error: 'org not in key scope' });
        const abs = (opts.blobRoot || './blobs') + '/' + rel;
        if (!existsSync(abs)) return json(res, 404, { error: 'not archived' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `inline; filename="${rel.split('/').pop()}"` });
        return res.end(readFileSync(abs));
      }

      // ---- outbound: post as the user (user mode) or the bot (app mode) ----
      if (p === '/say' && req.method === 'POST') {
        let body=''; for await (const c of req) body += c;
        const b = JSON.parse(body || '{}');
        const targetOrg = b.org || org;   // POST body can name an org, overriding ?org= — scope both
        if (forbidden(targetOrg)) return json(res, 403, { error: 'org not in key scope' });
        const creds = credsMap.get(targetOrg);
        if (!creds) return json(res, 400, { error: 'unknown org' });
        if (!b.channel || !b.text) return json(res, 400, { error: 'channel and text required' });
        // user-mode posts carry a :robot: badge so they're clearly attributed as automated;
        // app-mode posts skip it since the bot already has its own distinct identity
        const text = badgeFor(creds, b.text, b.no_badge);
        const params = { channel: b.channel, text };
        if (b.thread_ts) params.thread_ts = b.thread_ts;
        if (b.reply_broadcast) params.reply_broadcast = 'true';
        const pkey = targetOrg + '|' + b.channel + '|' + text.trim();
        // Only user mode's classifySelf (normalize.mjs) ever reads pendingOutbound — app mode
        // short-circuits to origin=hub via bot_id and never consults it, so populating it there
        // would just leak entries forever in a long-lived process. putOutbound below still runs
        // for both modes; it's a cheap, redundant durable guard either way.
        if (creds.mode !== 'app') store.pendingOutbound.set(pkey, Date.now() + 15000);   // register BEFORE post -> no echo race
        const r = await slackApi(creds, 'chat.postMessage', params);
        if (r.ok) await store.putOutbound(targetOrg, b.channel, r.ts);   // durable audit tag too
        else store.pendingOutbound.delete(pkey);
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, ts: r.ts, channel: r.channel } : { error: r.error });
      }
      if (p === '/react' && req.method === 'POST') {
        let body=''; for await (const c of req) body += c;
        const b = JSON.parse(body || '{}');
        const targetOrg = b.org || org;
        if (forbidden(targetOrg)) return json(res, 403, { error: 'org not in key scope' });
        const creds = credsMap.get(targetOrg);
        if (!creds) return json(res, 400, { error: 'unknown org' });
        const name = (b.emoji || '').replace(/:/g, '');
        let r = await slackApi(creds, 'reactions.add', { channel: b.channel, timestamp: b.ts, name });
        if (!r.ok && r.error === 'message_not_found') {                 // transient propagation race — retry once
          await new Promise(x => setTimeout(x, 900));
          r = await slackApi(creds, 'reactions.add', { channel: b.channel, timestamp: b.ts, name });
        }
        return json(res, (r.ok || r.error === 'already_reacted') ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
      }

      // ---- collector token push ----
      if (p === '/tokens' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c;
        const t = JSON.parse(body || '{}');
        if (!t.org || !t.token || !t.cookie) return json(res, 400, { error: 'org, token, cookie required' });
        await store.putToken(t); onToken(t);
        return json(res, 200, { ok: true, org: t.org });
      }

      // ---- app credential push: lets a running host be handed a Slack app credential without
      // a restart. Same shape as POST /tokens for user creds; verifies bot
      // identity via auth.test (app.mjs's verifyAndPersist, shared with the CLI/MCP surfaces —
      // this route is a thin wrapper, not a reimplementation) before persisting via putApp().
      // Never logs app_token/bot_token: on failure only the static error message is returned,
      // never the submitted body.
      if (p === '/apps' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c;
        const t = JSON.parse(body || '{}');
        if (!t.app_token || !t.bot_token) return json(res, 400, { error: 'app_token and bot_token required' });
        let verified;
        try { verified = await verifyAndPersist(store, { org: t.org || org, app_token: t.app_token, bot_token: t.bot_token, app_id: t.app_id || null }); }
        catch (e) { return json(res, 400, { error: e.message }); }
        // optional hook: a host can wire this to update its own credsMap immediately and/or
        // signal a split ingest holder. Every host also polls store.listApps() as a backstop
        // (see standalone.mjs/server.mjs/ingestd.mjs), so this route is correct even unwired.
        onApp(verified);
        return json(res, 200, { ok: true, org: verified.org, app_id: verified.app_id, bot_user_id: verified.bot_user_id });
      }

      return json(res, 404, { error: 'not found', routes: ['/health', '/tail', '/query', '/recent', '/history', '/thread', '/context', '/user', '/channel', '/file', 'POST /say', 'POST /react', 'POST /tokens', 'POST /apps', 'POST /keys/request', 'GET /keys/request/<id>'] });
    } catch (e) { return json(res, 500, { error: e.message }); }
  });
  server.listen(PORT, () => bus.emit('log', `API on :${PORT}`));
  return server;
}
