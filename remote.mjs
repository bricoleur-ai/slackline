import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// HTTP client for MCP "remote client" mode: lets mcp.mjs proxy every tool call to a slackline
// hub's api.mjs instead of holding its own Slack socket + store. Kept separate from mcp.mjs so
// the proxy logic — and the reconnecting /tail subscription that backs channel push — can be
// unit-tested with a stubbed global `fetch`, without touching stdio or a real Slack connection.
//
// Design note on transcript parity: /recent, /thread, /context already return a pre-built
// `transcript` string (api.mjs calls the same render.mjs used locally), so those three just
// pass it through. /query does not — it returns shaped JSON rows — so `search()` below rebuilds
// the same "[hh:mm] name: text" line format client-side (see transcriptFromResults/hhmm).

// SLACKLINE_REMOTE unset => remote mode is off; every other file in mcp.mjs behaves exactly as
// it does today. This is the only entry point that reads those env vars. Prefer a scoped
// SLACKLINE_KEY (x-slackline-key, checked via keys.mjs — reaches only the orgs it was issued
// for) over the master SLACKLINE_SECRET (x-slackline-secret — reaches every org/identity the hub
// holds); api.mjs and the standalone tail scripts already moved to scoped keys, this was the
// one remote-mode consumer left assuming the master secret was the only option.
//
// Config also comes from ~/.slackline/config.json ({"hub": "...", "key": "slk_...", "org": "..."}),
// because operators were already inventing that file. Found on a consumer host: agents there had
// hand-written it, plus curl wrappers that read the key from it via `curl -K`, specifically to
// keep the key out of argv where `ps` exposes it. Supporting it natively means one 0600 file per
// MACHINE instead of the same key pasted into every agent's MCP env block — which is what makes
// rotation tractable. Env still wins: an explicit value beats an ambient one.
export function remoteConfig(env = process.env, { configPath } = {}) {
  const file = readConfigFile(configPath);
  const url = env.SLACKLINE_REMOTE || file.hub || '';
  if (!url) return null;
  return {
    url: String(url).replace(/\/+$/, ''),
    secret: env.SLACKLINE_SECRET || file.secret || '',
    key: env.SLACKLINE_KEY || file.key || '',
    org: env.SLACKLINE_ORG || file.org || '',
  };
}

// Absent or malformed is not an error: this file is optional, and a consumer that configures
// everything through env must not fail to start because a stray config.json is unparseable.
function readConfigFile(path) {
  const p = path || `${homedir()}/.slackline/config.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch { return {}; }
}

// Never put the secret/key in a URL (query strings end up in logs/history); always a header.
// A scoped key takes precedence when both are set, matching the least-privilege intent of
// having one configured at all.
function authHeaders(cfg) {
  if (cfg.key) return { 'x-slackline-key': cfg.key };
  return cfg.secret ? { 'x-slackline-secret': cfg.secret } : {};
}

// Shared request path for every non-streaming tool. Throws on any non-2xx or network failure,
// with a message that names the hub URL and carries the hub's own error body — callers (mcp.mjs)
// wrap every tool call in try/catch already, so a thrown Error here becomes a loud MCP tool
// error instead of a silently-empty success. Never includes cfg.secret in the thrown message.
async function req(cfg, path, { method = 'GET', query, body } = {}) {
  const u = new URL(cfg.url + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(u, { method, headers: { ...authHeaders(cfg), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`cannot reach slackline hub at ${cfg.url}: ${e.message}`);
  }
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
  if (!res.ok) {
    const detail = typeof payload === 'string' ? payload : (payload.error || JSON.stringify(payload));
    throw new Error(`hub ${method} ${path} -> ${res.status}: ${detail}`);
  }
  return payload;
}

function hhmm(ts) { return new Date(Math.round(parseFloat(ts) * 1000)).toISOString().slice(11, 16); }
function lineFor(m) {
  const files = m.has_files && m.files && m.files.length ? ' ' + m.files.map(f => `[file: ${f.name}]`).join(' ') : '';
  const edited = m.edited ? ' (edited)' : '';
  return `[${hhmm(m.ts)}] ${m.user_name || m.user}: ${(m.text || '').replace(/\n/g, ' ')}${files}${edited}`;
}
function transcriptFromResults(results) { return (results || []).map(lineFor).join('\n'); }

// ---- one function per tool, same input shape as the local-mode switch case in mcp.mjs ----

export async function recent(cfg, { channel, limit }) {
  const r = await req(cfg, '/recent', { query: { org: cfg.org, channel, limit } });
  return r.transcript || '(nothing stored yet for this channel — new messages stream in live)';
}
export async function thread(cfg, { channel, thread_ts }) {
  const r = await req(cfg, '/thread', { query: { org: cfg.org, channel, thread_ts } });
  return r.transcript || '(thread not found)';
}
export async function history(cfg, { channel, limit, oldest, latest }) {
  const r = await req(cfg, '/history', { query: { org: cfg.org, channel, limit, oldest, latest } });
  // The hub reports backfill errors in the 200 JSON body (see api.mjs's /history), not as a
  // non-2xx — that lets this stay a friendly message instead of a thrown "hub GET /history ->
  // 400: ..." like req()'s generic error path would produce.
  if (r.error === 'not_in_channel') return `(no messages — the hub's Slack connection is not a member of channel ${channel}; invite it and try again)`;
  if (r.error) return 'error: ' + r.error;
  const more = r.has_more ? `\n(more available further back — pass oldest="${r.oldest_ts}" to continue)` : '';
  return (r.transcript || '(no messages in that range)') + more;
}
export async function context(cfg, { channel, ts }) {
  const r = await req(cfg, '/context', { query: { org: cfg.org, channel, ts } });
  return `channel ${r.channel}\n` + (r.transcript || '(no context)');
}
export async function search(cfg, { query, limit }) {
  const r = await req(cfg, '/query', { query: { org: cfg.org, q: query, limit } });
  return transcriptFromResults(r.results) || '(no matches in the rolling store)';
}
export async function say(cfg, { channel, text, thread_ts, no_badge }) {
  const r = await req(cfg, '/say', { method: 'POST', body: { org: cfg.org || undefined, channel, text, thread_ts, no_badge } });
  return `posted ts=${r.ts}`;
}
export async function react(cfg, { channel, ts, emoji }) {
  await req(cfg, '/react', { method: 'POST', body: { org: cfg.org || undefined, channel, ts, emoji } });
  return 'reacted';
}
// Identity here is the HUB's Slack connection, not this process's — this process holds no
// socket and no credentials, so there is no auth.test to call. Report what we can verify
// (the hub answers, which orgs it's live for) and say so plainly.
export async function whoami(cfg) {
  const r = await req(cfg, '/health');
  const orgs = (r.orgs_live || []).join(', ') || '(none)';
  return `remote client attached to slackline hub at ${cfg.url} (identity is the hub's, not this process's) — orgs_live: ${orgs}`;
}

// ---- channel push: one long-lived GET /tail NDJSON subscription per process ----
//
// Each mcp.mjs process (one per agent) owns its own RemoteTail instance, so the in-memory
// `since` watermark is naturally per-process — never shared across instances the way the
// old shell consumer's hardcoded /tmp/slackline_since file was.
export class RemoteTail {
  constructor(cfg, { channels = [], onMessage = () => {}, onEvent = () => {}, log = () => {},
                      backoffStart = 1000, backoffMax = 30000 } = {}) {
    this.cfg = cfg;
    this.channels = channels;      // SLACKLINE_CHANNEL_ONLY; empty = every channel the hub sees
    this.onMessage = onMessage;    // plain message rows (shape()'d)
    this.onEvent = onEvent;        // typed rows: message_edited/message_deleted/reaction_*
    this.log = log;
    this.since = null;             // last plain-message ts seen; per-instance, in memory only
    this._stopped = false;
    this._backoffStart = backoffStart;
    this._backoffMax = backoffMax;
    this._backoff = backoffStart;
  }

  _url() {
    const u = new URL(this.cfg.url + '/tail');
    if (this.cfg.org) u.searchParams.set('org', this.cfg.org);
    if (this.channels.length) u.searchParams.set('channels', this.channels.join(','));
    // Belt-and-suspenders loop guard: ask the hub to drop our own posts at the source (api.mjs's
    // `origin` filter) — SUBSCRIBER_GUIDE.md recommends this for HTTP /tail consumers — on top
    // of the onMessage-side origin==='hub' check below, matching bridges/core.mjs's guard.
    u.searchParams.set('origin', 'human,peer');
    // Gap-fill only kicks in hub-side when both since AND channels are present (api.mjs); with
    // no SLACKLINE_CHANNEL_ONLY configured a reconnect still can't lose messages we already
    // pushed (this.since still narrows what a *future* channel-scoped tail would replay), but a
    // truly gapless resume across an all-channels subscription needs the hub to support it.
    if (this.since) u.searchParams.set('since', this.since);
    return u;
  }

  // First connection is awaited by the caller (mcp.mjs) so an unreachable hub fails loudly at
  // startup — see the class doc above — instead of vanishing silently into the reconnect loop
  // below, which only ever runs after that first success. NOTE: connect() only awaits reaching
  // and validating the hub (_establish) — not the stream itself, which never resolves while
  // healthy (_consume loops for the socket's whole life). Awaiting _attempt() directly here would
  // block the caller forever on a good connection, so consumption + reconnects run in the
  // background via _pump once the first connect is confirmed good.
  async connect() {
    const res = await this._establish();
    this._backoff = this._backoffStart;
    this._pump(res);
  }

  async _pump(res) {
    try { await this._consume(res); }
    catch (e) { this.log(`tail: ${e.message}`); }
    if (!this._stopped) this._loop();
  }

  async _establish() {
    let res;
    try { res = await fetch(this._url(), { headers: authHeaders(this.cfg) }); }
    catch (e) { throw new Error(`cannot reach slackline hub at ${this.cfg.url}: ${e.message}`); }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`hub GET /tail -> ${res.status}: ${body || res.statusText}`);
    }
    return res;
  }

  async _attempt() {
    const res = await this._establish();
    this._backoff = this._backoffStart;   // reset only on a successful connect, not every attempt
    await this._consume(res);
  }

  async _consume(res) {
    if (!res.body) return;
    let buf = '';
    for await (const chunk of res.body) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;                    // keepalive pings are blank lines
        let row; try { row = JSON.parse(line); } catch { continue; }
        // Watermark only from plain message rows — store.since() (api.mjs) only ever replays
        // from the messages table, so a reaction/edit's ts (which points at some *other*,
        // possibly older, message) must never move `since` backwards or skip a real message.
        if (!row.type && row.ts && (!this.since || Number(row.ts) > Number(this.since))) this.since = row.ts;
        if (row.type) this.onEvent(row); else this.onMessage(row);
      }
    }
  }

  async _loop() {
    while (!this._stopped) {
      try { await this._attempt(); }
      catch (e) { this.log(`tail: ${e.message}`); }
      if (this._stopped) break;
      const wait = this._backoff;
      this._backoff = Math.min(this._backoff * 2, this._backoffMax);
      this.log(`tail: reconnecting in ${wait}ms${this.since ? ` (since ${this.since})` : ''}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  stop() { this._stopped = true; }
}
