import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// SQLite backend (node:sqlite — built in, no native deps). Same interface as the
// Postgres store; sync engine wrapped in async methods. Use for lightweight single-host
// or ephemeral (':memory:') operation.

const DDL = `
CREATE TABLE IF NOT EXISTS messages (
  org TEXT, channel TEXT, ts TEXT, thread_ts TEXT, "user" TEXT,
  subtype TEXT, text TEXT, has_files INTEGER DEFAULT 0, files_json TEXT,
  edited INTEGER DEFAULT 0, origin TEXT, deleted INTEGER DEFAULT 0, deleted_at INTEGER,
  reactions TEXT DEFAULT '{}', at INTEGER, PRIMARY KEY (org, channel, ts));
CREATE INDEX IF NOT EXISTS idx_msg_at ON messages(at);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(org, channel, thread_ts);
CREATE TABLE IF NOT EXISTS users (org TEXT, id TEXT, name TEXT, real_name TEXT, display_name TEXT, tz TEXT, is_bot INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (org, id));
CREATE TABLE IF NOT EXISTS channels (org TEXT, id TEXT, name TEXT, is_private INTEGER DEFAULT 0, is_im INTEGER DEFAULT 0, is_mpim INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (org, id));
CREATE TABLE IF NOT EXISTS threads (org TEXT, channel TEXT, thread_ts TEXT, hydrated_at INTEGER, PRIMARY KEY (org, channel, thread_ts));
CREATE TABLE IF NOT EXISTS outbound (org TEXT, channel TEXT, ts TEXT, at INTEGER, PRIMARY KEY (org, channel, ts));
CREATE TABLE IF NOT EXISTS tokens (org TEXT PRIMARY KEY, team_name TEXT, token TEXT, cookie TEXT, user_id TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS apps (
  org TEXT PRIMARY KEY, app_id TEXT, team_id TEXT, team_name TEXT,
  bot_token TEXT, app_token TEXT, bot_user_id TEXT, bot_id TEXT
);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, hash TEXT, label TEXT, orgs TEXT,
  created INTEGER, last_used INTEGER, revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS key_requests (
  id TEXT PRIMARY KEY, poll_hash TEXT, code TEXT, label TEXT, orgs TEXT, requester TEXT,
  status TEXT DEFAULT 'pending', created INTEGER, expires_at INTEGER, approver_org TEXT,
  dm_channel TEXT, decided_at INTEGER, decided_by TEXT, key_id TEXT, delivered INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_keyreq_code ON key_requests(code);
CREATE INDEX IF NOT EXISTS idx_keyreq_status ON key_requests(status);
`;

function norm(r) {
  if (!r) return r;
  if (typeof r.reactions === 'string') { try { r.reactions = JSON.parse(r.reactions); } catch { r.reactions = {}; } }
  if (typeof r.files_json === 'string' && r.files_json) { try { r.files_json = JSON.parse(r.files_json); } catch {} }
  return r;
}
const many = (rows) => rows.map(norm);

// ---- migration: table metadata shared by exportTable/importRows below. Primary keys match
// migrate.mjs's contract (org,channel,ts for messages; org,id for users/channels; etc) — used
// both to ORDER BY for deterministic dumps and to build the ON CONFLICT clause for full-row
// upserts. Deliberately local to this file (not imported from migrate.mjs / shared with the
// other two stores) so each backend stays a self-contained read of its own DDL, matching how
// the rest of this file already duplicates rather than shares SQL with postgres.mjs.
const PK = { messages: ['org', 'channel', 'ts'], users: ['org', 'id'], channels: ['org', 'id'],
  threads: ['org', 'channel', 'thread_ts'], outbound: ['org', 'channel', 'ts'], tokens: ['org'], apps: ['org'] };
function assertTable(name) { if (!PK[name]) throw new Error(`migrate: unknown table '${name}'`); }
const qcol = (c) => c === 'user' ? '"user"' : c;   // "user" is a reserved word in the messages DDL

// Booleans are stored as 0/1 INTEGER in sqlite; the portable row shape (shared with postgres,
// whose columns are real BOOLEAN) uses true/false, so exportTable coerces out and importRows
// coerces back in.
function toPortable(name, row) {
  if (name === 'messages') return { ...row, has_files: !!row.has_files, edited: !!row.edited, deleted: !!row.deleted };
  if (name === 'users') return { ...row, is_bot: !!row.is_bot };
  if (name === 'channels') return { ...row, is_private: !!row.is_private, is_im: !!row.is_im, is_mpim: !!row.is_mpim };
  return { ...row };
}

// Full-column upsert SQL for messages/threads/outbound — distinct from putMessage/
// markThreadHydrated/putOutbound above, which apply live-ingest semantics (merge-only fields,
// stamp Date.now()) that would corrupt a faithful copy. users/channels/tokens/apps don't need
// a separate statement: putUser/putChannel/putToken/putApp already set every column on
// conflict, so importRows below just calls those directly.
const FULL_UPSERT = {
  messages: `INSERT INTO messages (org,channel,ts,thread_ts,"user",subtype,text,has_files,files_json,edited,origin,deleted,deleted_at,reactions,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(org,channel,ts) DO UPDATE SET thread_ts=excluded.thread_ts, "user"=excluded."user", subtype=excluded.subtype,
      text=excluded.text, has_files=excluded.has_files, files_json=excluded.files_json, edited=excluded.edited,
      origin=excluded.origin, deleted=excluded.deleted, deleted_at=excluded.deleted_at, reactions=excluded.reactions, at=excluded.at`,
  threads: `INSERT INTO threads (org,channel,thread_ts,hydrated_at) VALUES (?,?,?,?)
    ON CONFLICT(org,channel,thread_ts) DO UPDATE SET hydrated_at=excluded.hydrated_at`,
  outbound: `INSERT INTO outbound (org,channel,ts,at) VALUES (?,?,?,?)
    ON CONFLICT(org,channel,ts) DO UPDATE SET at=excluded.at`,
};
function argsFor(name, r) {
  if (name === 'messages') return [r.org, r.channel, r.ts, r.thread_ts ?? null, r.user ?? null, r.subtype ?? null, r.text ?? '',
    r.has_files ? 1 : 0, r.files_json != null ? JSON.stringify(r.files_json) : null, r.edited ? 1 : 0,
    r.origin ?? null, r.deleted ? 1 : 0, r.deleted_at ?? null, JSON.stringify(r.reactions ?? {}), r.at ?? Date.now()];
  if (name === 'threads') return [r.org, r.channel, r.thread_ts, r.hydrated_at ?? Date.now()];
  return [r.org, r.channel, r.ts, r.at ?? Date.now()];   // outbound
}

export class SqliteStore {
  constructor(path) { this.path = path || ':memory:'; this.pendingOutbound = new Map(); }
  async init() {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch { throw new Error('SLACKLINE_STORE=sqlite needs Node >= 22.13 (node:sqlite). Use SLACKLINE_STORE=memory or a newer Node.'); }
    // DatabaseSync will not create missing parent directories, and the default path
    // now lives under ~/.slackline rather than the cwd — so the first run of a fresh
    // install would otherwise fail on an ENOENT that reads like a permissions bug.
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;');
    this.db.exec(DDL);
    this._p = (sql) => this.db.prepare(sql);
  }

  async putMessage(m) {
    this._p(`INSERT INTO messages (org,channel,ts,thread_ts,"user",subtype,text,has_files,files_json,edited,origin,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org,channel,ts) DO UPDATE SET text=excluded.text, edited=excluded.edited,
        has_files=excluded.has_files, files_json=excluded.files_json,
        -- 'hub' AND 'human' are both live-ingest conclusions about OUR OWN messages, reached with
      -- context a backfill does not have (the outbound guard, pendingOutbound). Channel backfill
      -- can only tell self-vs-other, so it would rewrite a 'human' row to 'hub' — and consumers
      -- filtering origin=human,peer would then silently DROP the operator's own typed messages.
      -- Live classification wins; backfill may only fill in what is still unknown.
      origin=CASE WHEN messages.origin IN ('hub','human') THEN messages.origin ELSE COALESCE(excluded.origin, messages.origin) END`)
      .run(m.org, m.channel, m.ts, m.thread_ts ?? null, m.user ?? null, m.subtype ?? null, m.text ?? '',
           m.has_files ? 1 : 0, m.files_json ?? null, m.edited ? 1 : 0, m.origin ?? null, m.at ?? Date.now());
  }
  async recent(org, channel, limit = 20) {
    return many(this._p(`SELECT * FROM messages WHERE org=? AND channel=? ORDER BY ts DESC LIMIT ?`).all(org, channel, limit)).reverse();
  }
  async getMessage(org, channel, ts) { return norm(this._p('SELECT * FROM messages WHERE org=? AND channel=? AND ts=?').get(org, channel, ts) || null); }
  async thread(org, channel, thread_ts) {
    return many(this._p(`SELECT * FROM messages WHERE org=? AND channel=? AND (thread_ts=? OR ts=?) ORDER BY ts ASC`).all(org, channel, thread_ts, thread_ts));
  }
  async search(org, term, limit = 30) {
    return many(this._p(`SELECT * FROM messages WHERE org=? AND text LIKE ? ORDER BY ts DESC LIMIT ?`).all(org, '%' + term + '%', limit));
  }
  async around(org, channel, ts, before = 6, after = 3) {
    const b = many(this._p(`SELECT * FROM messages WHERE org=? AND channel=? AND ts<=? ORDER BY ts DESC LIMIT ?`).all(org, channel, ts, before + 1)).reverse();
    const a = many(this._p(`SELECT * FROM messages WHERE org=? AND channel=? AND ts>? ORDER BY ts ASC LIMIT ?`).all(org, channel, ts, after));
    return [...b, ...a];
  }
  async putUser(org, u) {
    this._p(`INSERT INTO users (org,id,name,real_name,display_name,tz,is_bot,updated) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(org,id) DO UPDATE SET name=excluded.name, real_name=excluded.real_name, display_name=excluded.display_name, tz=excluded.tz, is_bot=excluded.is_bot, updated=excluded.updated`)
      .run(org, u.id, u.name ?? null, u.real_name ?? null, u.display_name ?? null, u.tz ?? null, u.is_bot ? 1 : 0, Date.now());
  }
  async getUser(org, id) { return this._p('SELECT * FROM users WHERE org=? AND id=?').get(org, id) || null; }
  async putChannel(org, c) {
    this._p(`INSERT INTO channels (org,id,name,is_private,is_im,is_mpim,updated) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(org,id) DO UPDATE SET name=excluded.name, is_private=excluded.is_private, is_im=excluded.is_im, is_mpim=excluded.is_mpim, updated=excluded.updated`)
      .run(org, c.id, c.name ?? null, c.is_private ? 1 : 0, c.is_im ? 1 : 0, c.is_mpim ? 1 : 0, Date.now());
  }
  async getChannel(org, id) { return this._p('SELECT * FROM channels WHERE org=? AND id=?').get(org, id) || null; }
  async threadHydrated(org, channel, thread_ts) { return !!this._p('SELECT 1 FROM threads WHERE org=? AND channel=? AND thread_ts=?').get(org, channel, thread_ts); }
  async markThreadHydrated(org, channel, thread_ts) { this._p(`INSERT OR REPLACE INTO threads (org,channel,thread_ts,hydrated_at) VALUES (?,?,?,?)`).run(org, channel, thread_ts, Date.now()); }
  async putToken(t) {
    this._p(`INSERT INTO tokens (org,team_name,token,cookie,user_id,updated) VALUES (?,?,?,?,?,?)
      ON CONFLICT(org) DO UPDATE SET team_name=excluded.team_name, token=excluded.token, cookie=excluded.cookie, user_id=excluded.user_id, updated=excluded.updated`)
      .run(t.org, t.team_name ?? null, t.token, t.cookie, t.user_id ?? null, Date.now());
  }
  async getTokens() { return this._p('SELECT * FROM tokens').all(); }
  async putApp(a) {
    this._p(`INSERT INTO apps (org, app_id, team_id, team_name, bot_token, app_token, bot_user_id, bot_id)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(org) DO UPDATE SET app_id=excluded.app_id, team_id=excluded.team_id,
        team_name=excluded.team_name, bot_token=excluded.bot_token, app_token=excluded.app_token,
        bot_user_id=excluded.bot_user_id, bot_id=excluded.bot_id`)
      .run(a.org, a.app_id, a.team_id, a.team_name, a.bot_token, a.app_token, a.bot_user_id, a.bot_id);
  }
  async getApp(org) { return this._p('SELECT * FROM apps WHERE org = ?').get(org) || null; }
  async listApps() { return this._p('SELECT * FROM apps').all(); }
  // ---- keys: scoped consumer credentials (see keys.mjs — hash only, never raw key material) --
  async putKey(k) {
    this._p(`INSERT INTO keys (id,hash,label,orgs,created,last_used,revoked) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, label=excluded.label, orgs=excluded.orgs, revoked=excluded.revoked`)
      .run(k.id, k.hash, k.label ?? null, k.orgs ?? '*', k.created ?? Date.now(), k.last_used ?? null, k.revoked ? 1 : 0);
  }
  async getKey(id) { return this._p('SELECT * FROM keys WHERE id=?').get(id) || null; }
  async listKeys() { return this._p('SELECT * FROM keys ORDER BY created DESC').all(); }
  async touchKey(id) { this._p('UPDATE keys SET last_used=? WHERE id=?').run(Date.now(), id); }
  async revokeKey(id) { return this._p('UPDATE keys SET revoked=1 WHERE id=?').run(id).changes > 0; }

  // ---- key_requests: Slack-mediated key approval flow (see keyrequest.mjs) — same "hash/public
  // id only, never raw key material" contract as `keys` above.
  async putKeyRequest(r) {
    this._p(`INSERT INTO key_requests (id,poll_hash,code,label,orgs,requester,status,created,expires_at,approver_org,dm_channel,decided_at,decided_by,key_id,delivered)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.poll_hash, r.code, r.label ?? '', r.orgs, r.requester ?? '', r.status ?? 'pending',
           r.created ?? Date.now(), r.expires_at, r.approver_org, r.dm_channel ?? null,
           r.decided_at ?? null, r.decided_by ?? null, r.key_id ?? null, r.delivered ? 1 : 0);
  }
  async getKeyRequest(id) { return this._p('SELECT * FROM key_requests WHERE id=?').get(id) || null; }
  async getPendingKeyRequestByCode(code) {
    return this._p(`SELECT * FROM key_requests WHERE code=? AND status='pending' ORDER BY created DESC LIMIT 1`).get(code) || null;
  }
  async listKeyRequests() { return this._p('SELECT * FROM key_requests ORDER BY created DESC').all(); }
  async countPendingKeyRequests(now = Date.now()) {
    return this._p(`SELECT count(*) c FROM key_requests WHERE status='pending' AND expires_at > ?`).get(now).c;
  }
  async claimKeyRequestApproval(id, { decided_by, decided_at }) {
    return this._p(`UPDATE key_requests SET status='approved', decided_by=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(decided_by, decided_at, id).changes > 0;
  }
  async setKeyRequestKeyId(id, key_id) { this._p('UPDATE key_requests SET key_id=? WHERE id=?').run(key_id, id); }
  async denyKeyRequest(id, { decided_by, decided_at }) {
    return this._p(`UPDATE key_requests SET status='denied', decided_by=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(decided_by, decided_at, id).changes > 0;
  }
  async expireKeyRequest(id) { return this._p(`UPDATE key_requests SET status='expired' WHERE id=? AND status='pending'`).run(id).changes > 0; }
  async revertKeyRequestToPending(id) {
    return this._p(`UPDATE key_requests SET status='pending', key_id=NULL, decided_by=NULL, decided_at=NULL WHERE id=? AND status='approved'`).run(id).changes > 0;
  }
  async markKeyRequestDelivered(id) { return this._p('UPDATE key_requests SET delivered=1 WHERE id=? AND delivered=0').run(id).changes > 0; }

  async putOutbound(org, channel, ts) { this._p(`INSERT OR IGNORE INTO outbound (org,channel,ts,at) VALUES (?,?,?,?)`).run(org, channel, ts, Date.now()); }
  async isOutbound(org, channel, ts) { return !!this._p('SELECT 1 FROM outbound WHERE org=? AND channel=? AND ts=?').get(org, channel, ts); }
  async setReaction(org, channel, ts, emoji, user, add = true) {
    const row = await this.getMessage(org, channel, ts); if (!row) return 0;
    const r = (row.reactions && typeof row.reactions === 'object') ? row.reactions : {};
    const set = new Set(r[emoji] || []); add ? set.add(user) : set.delete(user);
    if (set.size) r[emoji] = [...set]; else delete r[emoji];
    this._p('UPDATE messages SET reactions=? WHERE org=? AND channel=? AND ts=?').run(JSON.stringify(r), org, channel, ts); return 1;
  }
  async markDeleted(org, channel, ts) { return this._p('UPDATE messages SET deleted=1, deleted_at=? WHERE org=? AND channel=? AND ts=?').run(Date.now(), org, channel, ts).changes; }
  async setLocalFiles(org, channel, ts, files_json) { this._p('UPDATE messages SET files_json=? WHERE org=? AND channel=? AND ts=?').run(files_json, org, channel, ts); }
  async since(org, channels, sinceTs, limit = 1000) {
    if (!channels || !channels.length) return [];
    const ph = channels.map(() => '?').join(',');
    return many(this._p(`SELECT * FROM messages WHERE org=? AND channel IN (${ph}) AND ts>? ORDER BY ts ASC LIMIT ?`).all(org, ...channels, sinceTs, limit));
  }
  async reconcileOutbound() { this._p("UPDATE messages SET origin='hub' WHERE origin IS NOT 'hub' AND EXISTS (SELECT 1 FROM outbound o WHERE o.org=messages.org AND o.channel=messages.channel AND o.ts=messages.ts)").run(); }
  async prune(retainMs) { return this._p('DELETE FROM messages WHERE at < ?').run(Date.now() - retainMs).changes; }
  async stats() {
    const c = (sql) => this._p(sql).get().c;
    return { messages: c('SELECT count(*) c FROM messages'), deleted: c('SELECT count(*) c FROM messages WHERE deleted=1'),
             users: c('SELECT count(*) c FROM users'), channels: c('SELECT count(*) c FROM channels'), orgs: c('SELECT count(*) c FROM tokens') };
  }

  // ---- migration: bulk dump/load (see PK/FULL_UPSERT/toPortable above).
  // .iterate() steps the sqlite cursor row-by-row instead of .all()'s full-array materialize,
  // so a large messages table is never buffered whole in JS — the actual requirement behind
  // "must stream/batch messages, not load a whole workspace into memory as one array".
  async *exportTable(name) {
    assertTable(name);
    const cols = PK[name].map(qcol).join(', ');
    for (const row of this._p(`SELECT * FROM ${name} ORDER BY ${cols}`).iterate()) yield toPortable(name, norm(row));
  }
  async importRows(name, rows) {
    assertTable(name);
    let n = 0;
    // One transaction per call: sqlite is in-process (no round-trip cost to amortize via
    // batching like postgres below), so the only goal here is atomicity — either the whole
    // table's worth of rows lands, or none does, and WAL mode means the DB file itself is never
    // partially rewritten mid-loop.
    this.db.exec('BEGIN');
    try {
      if (name === 'users' || name === 'channels' || name === 'tokens' || name === 'apps') {
        const put = name === 'users' ? (r) => this.putUser(r.org, r) : name === 'channels' ? (r) => this.putChannel(r.org, r)
          : name === 'tokens' ? (r) => this.putToken(r) : (r) => this.putApp(r);
        for await (const row of rows) { await put(row); n++; }
      } else {
        const stmt = this._p(FULL_UPSERT[name]);
        for await (const row of rows) { stmt.run(...argsFor(name, row)); n++; }
      }
      this.db.exec('COMMIT');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
    return n;
  }
}
