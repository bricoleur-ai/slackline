// Slack Web API (as the user, or as the bot in app mode) + lazy enrichers. Never bulk-fetches
// users (that pattern gets xoxc/xoxd invalidated) — resolves one id at a time on sight.
import { writeFileSync, existsSync, mkdirSync } from 'fs';

// Auth differs by credential mode: user creds authenticate with the `d` cookie
// (token rides in the form body), app creds with a bot bearer. Absent mode = user.
export function authHeaders(creds) {
  if (creds.mode === 'app') return { Authorization: 'Bearer ' + creds.bot_token };
  return { Cookie: 'd=' + creds.cookie };
}

// File downloads are not Web API calls: user mode needs cookie AND bearer.
export function fileAuthHeaders(creds) {
  if (creds.mode === 'app') return { Authorization: 'Bearer ' + creds.bot_token };
  return { Cookie: 'd=' + creds.cookie, Authorization: 'Bearer ' + creds.token };
}

// opts.retry429 is opt-in (default off) so this can't silently add multi-second sleeps to every
// call site (say/react/users.info etc.) — only backfillChannel's conversations.history paging,
// which is Tier 3 (~50/min) and can plausibly get rate-limited, asks for it.
export async function api(creds, method, params = {}, opts = {}) {
  const body = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders(creds) };
  if (creds.mode !== 'app') body.set('token', creds.token);   // user auth carries the token in-body
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://slack.com/api/' + method, { method: 'POST', headers, body });
    if (opts.retry429 && r.status === 429 && attempt < (opts.maxRetries ?? 3)) {
      const secs = Math.min(parseInt((r.headers && r.headers.get && r.headers.get('retry-after')) || '1', 10) || 1, 30);
      await (opts.sleep || (ms => new Promise(res => setTimeout(res, ms))))(secs * 1000);
      continue;
    }
    return r.json();
  }
}

// Resolve a single user id -> cache. Refreshes if older than maxAgeMs.
export async function resolveUser(store, org, creds, id, maxAgeMs = 24 * 3600e3) {
  if (!id) return null;
  const cached = await store.getUser(org, id);
  if (cached && Date.now() - cached.updated < maxAgeMs) return cached;
  const r = await api(creds, 'users.info', { user: id }).catch(() => null);
  if (r && r.ok) {
    const u = r.user, p = u.profile || {};
    await store.putUser(org, { id, name: u.name, real_name: p.real_name || u.real_name,
      display_name: p.display_name, tz: u.tz, is_bot: u.is_bot });
    return await store.getUser(org, id);
  }
  return cached || null;
}

export async function resolveChannel(store, org, creds, id, maxAgeMs = 24 * 3600e3) {
  if (!id) return null;
  const cached = await store.getChannel(org, id);
  if (cached && Date.now() - cached.updated < maxAgeMs) return cached;
  const r = await api(creds, 'conversations.info', { channel: id }).catch(() => null);
  if (r && r.ok) {
    const c = r.channel;
    await store.putChannel(org, { id, name: c.name || (c.is_im ? 'DM' : null),
      is_private: c.is_private, is_im: c.is_im, is_mpim: c.is_mpim });
    return await store.getChannel(org, id);
  }
  return cached || null;
}

// On-demand thread hydration: pull the whole thread once, store every message.
export async function hydrateThread(store, org, creds, channel, thread_ts, blobRoot) {
  if (await store.threadHydrated(org, channel, thread_ts)) return await store.thread(org, channel, thread_ts);
  const r = await api(creds, 'conversations.replies',
    { channel, ts: thread_ts, limit: '200' }).catch(() => null);
  if (r && r.ok) {
    for (const m of r.messages || []) {
      const files = (m.files || []).map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private }));
      await store.putMessage({ org, channel, ts: m.ts, thread_ts: m.thread_ts || m.ts,
        user: m.user || m.bot_id, subtype: m.subtype, text: m.text || '',
        has_files: files.length > 0, files_json: files.length ? JSON.stringify(files) : null,
        edited: m.edited ? 1 : 0, at: Math.round(parseFloat(m.ts) * 1000) });
      if (files.length && blobRoot) archiveFiles(store, creds, org, channel, m.ts, files, blobRoot).catch(() => {});
    }
    await store.markThreadHydrated(org, channel, thread_ts);
  }
  return await store.thread(org, channel, thread_ts);
}

// Download one file to the blob dir (skips if present).
export async function downloadFile(creds, file, blobDir) {
  const path = `${blobDir}/${file.id}_${(file.name || 'file').replace(/[^\w.\-]/g, '_')}`;
  if (existsSync(path)) return path;
  const r = await fetch(file.url, { headers: fileAuthHeaders(creds) });
  if (!r.ok) return null;
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

// Resolve names for a set of rows before rendering (cache-guarded => cheap, never bulk).
export async function ensureNames(store, org, creds, rows) {
  if (!creds) return;
  for (const u of new Set(rows.map(r => r.user).filter(Boolean))) {
    await resolveUser(store, org, creds, u).catch(() => {});
  }
}

// Fetch and store a window of messages around a ts (for cold /context on history).
export async function hydrateAround(store, org, creds, channel, ts, before = 8, after = 4) {
  const put = async (arr) => { for (const m of arr || []) {
    if (m.subtype && !['thread_broadcast','me_message','file_share'].includes(m.subtype)) continue;
    await store.putMessage({ org, channel, ts: m.ts, thread_ts: m.thread_ts || m.ts,
      user: m.user || m.bot_id, subtype: m.subtype, text: m.text || '',
      has_files: !!(m.files && m.files.length),
      files_json: m.files ? JSON.stringify(m.files.map(f => ({ id:f.id, name:f.name, mimetype:f.mimetype, size:f.size, url:f.url_private_download||f.url_private }))) : null,
      edited: m.edited ? 1 : 0, at: Math.round(parseFloat(m.ts) * 1000) });
  }};
  const older = await api(creds, 'conversations.history', { channel, latest: ts, inclusive: 'true', limit: String(before + 1) }).catch(() => null);
  const newer = await api(creds, 'conversations.history', { channel, oldest: ts, limit: String(after) }).catch(() => null);
  await put(older && older.messages); await put(newer && newer.messages);
}

// ---- channel history backfill ----------------------------------------------------------------
// The missing "look back": slack_recent/slack_search only ever answer from what live ingest has
// seen since the socket connected, and hydrateAround/hydrateThread above can only hydrate
// around/inside a message the caller already has a ts for. This is the one that needs no
// anchor — it pages conversations.history directly, applying the same subtype filter +
// putMessage storage as the rest of this file so a backfilled row is indistinguishable from a
// live-ingested one.
const HISTORY_SUBTYPES = ['thread_broadcast', 'me_message', 'file_share'];

// Live ingest (normalize.mjs's isSelfAuthored) also consults an outbound guard — classifySelf —
// to catch the socket-echo race right after posting via /say. That nuance is meaningless for
// history (nothing here was "just posted"), so this collapses to the plain identity check: did
// this account/bot write the message, yes or no. Mislabeling our own old posts as origin=peer is
// the specific failure mode this exists to avoid (an agent would otherwise treat its own history
// as something to react/reply to).
function isSelfAuthored(m, creds) {
  if (creds.mode === 'app') return m.bot_id === creds.bot_id || m.user === creds.bot_user_id;
  return (m.user || m.bot_id) === (creds.user_id || null);
}

// Pages conversations.history newest-first (Slack's default), optionally bounded by
// oldest/latest, storing every message under the live-ingest rules. Bounded two independent
// ways so a huge or busy channel can't run away: `limit` (total messages processed) and `pages`
// (raw call count — protects against a channel where most rows get subtype-filtered out, which
// would otherwise let `limit` stall the loop across many near-empty pages). Returns the stored
// rows in ascending order, ready for render.mjs's transcript()/shape(), alongside counters a
// caller can use to tell "genuinely empty channel" apart from "hub can't see this channel" apart
// from "there's more, we just stopped at the cap".
export async function backfillChannel(store, org, creds, channel, opts = {}) {
  const wantTotal = Math.min(opts.limit || 100, 1000);
  const maxPages = Math.min(opts.pages || 5, 20);   // conversations.history is Tier 3 (~50/min)
  const sleep = opts.sleep || (ms => new Promise(res => setTimeout(res, ms)));

  let cursor, fetched = 0, stored = 0, oldest_ts = null, has_more = false, page = 0;
  const messages = [];
  while (page < maxPages && fetched < wantTotal) {
    const params = { channel, limit: String(Math.min(200, wantTotal - fetched)) };
    if (opts.oldest) params.oldest = opts.oldest;
    if (opts.latest) params.latest = opts.latest;
    if (cursor) params.cursor = cursor;
    const r = await api(creds, 'conversations.history', params, { retry429: true, sleep }).catch(() => null);
    page++;
    // not_in_channel (bot never invited) is the single most likely real-world cause and must
    // reach the caller verbatim, not get swallowed into an empty-looking result — same for any
    // other Slack error (invalid_auth, channel_not_found, ...).
    if (!r || !r.ok) return { fetched, stored, oldest_ts, has_more: false, messages: messages.reverse(),
      ...(r && r.error ? { error: r.error } : {}) };

    for (const m of r.messages || []) {
      fetched++;
      if (!oldest_ts || m.ts < oldest_ts) oldest_ts = m.ts;
      if (m.subtype && !HISTORY_SUBTYPES.includes(m.subtype)) continue;
      const files = (m.files || []).map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private }));
      const rec = { org, channel, ts: m.ts, thread_ts: m.thread_ts || m.ts,
        user: m.user || m.bot_id, subtype: m.subtype || null, text: m.text || '',
        has_files: files.length > 0, files_json: files.length ? JSON.stringify(files) : null,
        edited: m.edited ? 1 : 0, origin: isSelfAuthored(m, creds) ? 'hub' : 'peer',
        at: Math.round(parseFloat(m.ts) * 1000) };
      await store.putMessage(rec);   // idempotent on (org, channel, ts) — safe to re-run
      stored++; messages.push(rec);
      if (files.length && opts.blobRoot) archiveFiles(store, creds, org, channel, m.ts, files, opts.blobRoot).catch(() => {});
    }
    has_more = !!r.has_more;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (!cursor || !has_more) break;
  }
  return { fetched, stored, oldest_ts, has_more, messages: messages.reverse() };   // Slack pages newest-first; transcript() wants ascending
}


// Archive a message's files into organized subfolders: blobs/<org>/<channel>/<YYYY-MM-DD>/<id>_<name>
// Records the relative path back onto files_json[].local so the API can serve them.
export async function archiveFiles(store, creds, org, channel, ts, files, blobRoot) {
  const date = new Date(Math.round(parseFloat(ts) * 1000)).toISOString().slice(0, 10);
  const dir = `${blobRoot}/${org}/${channel}/${date}`;
  let changed = false;
  for (const f of files) {
    if (!f.url || f.local) continue;
    const safe = String(f.name || f.id).replace(/[^\w.\-]/g, '_').slice(0, 120);
    const rel = `${org}/${channel}/${date}/${f.id}_${safe}`;
    const abs = `${blobRoot}/${rel}`;
    try {
      if (!existsSync(abs)) {
        const r = await fetch(f.url, { headers: fileAuthHeaders(creds) });
        if (!r.ok) continue;
        mkdirSync(dir, { recursive: true });
        writeFileSync(abs, Buffer.from(await r.arrayBuffer()));
      }
      f.local = rel; changed = true;
    } catch {}
  }
  if (changed) await store.setLocalFiles(org, channel, ts, JSON.stringify(files));
}
