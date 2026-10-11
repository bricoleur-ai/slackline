// Rolling store on PostgreSQL (pg). Recent messages + lazy user/channel caches
// + thread hydration + outbound tags + deletions/edits/reactions. All methods async.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  org TEXT, channel TEXT, ts TEXT, thread_ts TEXT, "user" TEXT,
  subtype TEXT, text TEXT, has_files BOOLEAN DEFAULT false,
  files_json JSONB, edited BOOLEAN DEFAULT false, origin TEXT,
  deleted BOOLEAN DEFAULT false, deleted_at BIGINT,
  reactions JSONB DEFAULT '{}', at BIGINT,
  PRIMARY KEY (org, channel, ts)
);
CREATE INDEX IF NOT EXISTS idx_msg_at ON messages(at);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(org, channel, thread_ts);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(org, "user");
CREATE INDEX IF NOT EXISTS idx_msg_text_trgm ON messages USING gin (text gin_trgm_ops);
CREATE TABLE IF NOT EXISTS users (
  org TEXT, id TEXT, name TEXT, real_name TEXT, display_name TEXT,
  tz TEXT, is_bot BOOLEAN DEFAULT false, updated BIGINT, PRIMARY KEY (org, id)
);
CREATE TABLE IF NOT EXISTS channels (
  org TEXT, id TEXT, name TEXT, is_private BOOLEAN DEFAULT false,
  is_im BOOLEAN DEFAULT false, is_mpim BOOLEAN DEFAULT false, updated BIGINT, PRIMARY KEY (org, id)
);
CREATE TABLE IF NOT EXISTS threads (
  org TEXT, channel TEXT, thread_ts TEXT, hydrated_at BIGINT, PRIMARY KEY (org, channel, thread_ts)
);
CREATE TABLE IF NOT EXISTS outbound (
  org TEXT, channel TEXT, ts TEXT, at BIGINT, PRIMARY KEY (org, channel, ts)
);
CREATE TABLE IF NOT EXISTS tokens (
  org TEXT PRIMARY KEY, team_name TEXT, token TEXT, cookie TEXT, user_id TEXT, updated BIGINT
);
CREATE TABLE IF NOT EXISTS apps (
  org TEXT PRIMARY KEY, app_id TEXT, team_id TEXT, team_name TEXT,
  bot_token TEXT, app_token TEXT, bot_user_id TEXT, bot_id TEXT
);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, hash TEXT, label TEXT, orgs TEXT,
  created BIGINT, last_used BIGINT, revoked BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS key_requests (
  id TEXT PRIMARY KEY, poll_hash TEXT, code TEXT, label TEXT, orgs TEXT, requester TEXT,
  status TEXT DEFAULT 'pending', created BIGINT, expires_at BIGINT, approver_org TEXT,
  dm_channel TEXT, decided_at BIGINT, decided_by TEXT, key_id TEXT, delivered BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_keyreq_code ON key_requests(code);
CREATE INDEX IF NOT EXISTS idx_keyreq_status ON key_requests(status);
`;

// ---- migration: table metadata for exportTable/importRows (bottom of the class). Deliberately
// local to this file rather than shared with sqlite.mjs/memory.mjs — see the matching comment
// in sqlite.mjs for why. pk drives both the keyset-pagination ORDER BY (below) and the ON
// CONFLICT target for upserts; cols is every column in a portable row for that table.
const TABLE_DEF = {
  messages: { pk: ['org', 'channel', 'ts'], cols: ['org', 'channel', 'ts', 'thread_ts', 'user', 'subtype', 'text', 'has_files', 'files_json', 'edited', 'origin', 'deleted', 'deleted_at', 'reactions', 'at'] },
  users: { pk: ['org', 'id'], cols: ['org', 'id', 'name', 'real_name', 'display_name', 'tz', 'is_bot', 'updated'] },
  channels: { pk: ['org', 'id'], cols: ['org', 'id', 'name', 'is_private', 'is_im', 'is_mpim', 'updated'] },
  threads: { pk: ['org', 'channel', 'thread_ts'], cols: ['org', 'channel', 'thread_ts', 'hydrated_at'] },
  outbound: { pk: ['org', 'channel', 'ts'], cols: ['org', 'channel', 'ts', 'at'] },
  tokens: { pk: ['org'], cols: ['org', 'team_name', 'token', 'cookie', 'user_id', 'updated'] },
  apps: { pk: ['org'], cols: ['org', 'app_id', 'team_id', 'team_name', 'bot_token', 'app_token', 'bot_user_id', 'bot_id'] },
};
const JSON_COLS = new Set(['files_json', 'reactions']);
const BOOL_COLS = new Set(['has_files', 'edited', 'deleted', 'is_bot', 'is_private', 'is_im', 'is_mpim']);
function assertTable(name) { if (!TABLE_DEF[name]) throw new Error(`migrate: unknown table '${name}'`); }
const qcol = (c) => c === 'user' ? '"user"' : `"${c}"`;
const qtuple = (cols) => '(' + cols.map(qcol).join(',') + ')';

// JSONB/BOOLEAN columns round-trip as JS objects/booleans through node-postgres already (its
// default type parsers deserialize both on SELECT), so a row read back off the wire is already
// in the portable shape exportTable/importRows agree on — nothing to coerce here, unlike sqlite.
function rowValue(col, row) {
  const v = row[col];
  if (JSON_COLS.has(col)) return v == null ? (col === 'reactions' ? '{}' : null) : JSON.stringify(v);
  if (BOOL_COLS.has(col)) return !!v;
  return v ?? null;
}

const MIGRATE_BATCH = 500;   // rows per SELECT page and per multi-row upsert statement

export class PostgresStore {
  constructor(connString) { this._conn = connString; this.pendingOutbound = new Map(); }
  async init() {
    const pg = (await import('pg')).default;
    this.pool = new pg.Pool({ connectionString: this._conn, max: 10 });
    try { await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;'); } catch {}
    await this.pool.query(SCHEMA);
    for (const alter of [
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin TEXT;',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false;',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;',
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}';",
    ]) await this.pool.query(alter).catch(() => {});
  }
  q(text, params) { return this.pool.query(text, params); }

  async putMessage(m) {
    await this.pool.query(
      `INSERT INTO messages (org,channel,ts,thread_ts,"user",subtype,text,has_files,files_json,edited,origin,at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org,channel,ts) DO UPDATE SET
         text=EXCLUDED.text, edited=EXCLUDED.edited,
         has_files=EXCLUDED.has_files, files_json=EXCLUDED.files_json,
         -- 'hub' AND 'human' are both live-ingest conclusions about OUR OWN messages, reached with
      -- context a backfill does not have (the outbound guard, pendingOutbound). Channel backfill
      -- can only tell self-vs-other, so it would rewrite a 'human' row to 'hub' — and consumers
      -- filtering origin=human,peer would then silently DROP the operator's own typed messages.
      -- Live classification wins; backfill may only fill in what is still unknown.
      origin=CASE WHEN messages.origin IN ('hub','human') THEN messages.origin ELSE COALESCE(EXCLUDED.origin, messages.origin) END`,
      [m.org, m.channel, m.ts, m.thread_ts ?? null, m.user ?? null, m.subtype ?? null,
       m.text ?? '', !!m.has_files, m.files_json ?? null, !!m.edited, m.origin ?? null, m.at ?? Date.now()]);
  }
  async recent(org, channel, limit = 20) {
    return (await this.pool.query(`SELECT * FROM messages WHERE org=$1 AND channel=$2 ORDER BY ts DESC LIMIT $3`,
      [org, channel, limit])).rows.reverse();
  }
  async getMessage(org, channel, ts) {
    return (await this.pool.query('SELECT * FROM messages WHERE org=$1 AND channel=$2 AND ts=$3', [org, channel, ts])).rows[0] || null;
  }
  async thread(org, channel, thread_ts) {
    return (await this.pool.query(`SELECT * FROM messages WHERE org=$1 AND channel=$2 AND (thread_ts=$3 OR ts=$3) ORDER BY ts ASC`,
      [org, channel, thread_ts])).rows;
  }
  async search(org, term, limit = 30) {
    return (await this.pool.query(`SELECT * FROM messages WHERE org=$1 AND text ILIKE $2 ORDER BY ts DESC LIMIT $3`,
      [org, '%' + term + '%', limit])).rows;
  }
  async around(org, channel, ts, before = 6, after = 3) {
    const b = await this.pool.query(`SELECT * FROM messages WHERE org=$1 AND channel=$2 AND ts<=$3 ORDER BY ts DESC LIMIT $4`, [org, channel, ts, before + 1]);
    const a = await this.pool.query(`SELECT * FROM messages WHERE org=$1 AND channel=$2 AND ts>$3 ORDER BY ts ASC LIMIT $4`, [org, channel, ts, after]);
    return [...b.rows.reverse(), ...a.rows];
  }

  async putUser(org, u) {
    await this.pool.query(
      `INSERT INTO users (org,id,name,real_name,display_name,tz,is_bot,updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org,id) DO UPDATE SET name=EXCLUDED.name, real_name=EXCLUDED.real_name,
         display_name=EXCLUDED.display_name, tz=EXCLUDED.tz, is_bot=EXCLUDED.is_bot, updated=EXCLUDED.updated`,
      [org, u.id, u.name ?? null, u.real_name ?? null, u.display_name ?? null, u.tz ?? null, !!u.is_bot, Date.now()]);
  }
  async getUser(org, id) { return (await this.pool.query('SELECT * FROM users WHERE org=$1 AND id=$2', [org, id])).rows[0] || null; }

  async putChannel(org, c) {
    await this.pool.query(
      `INSERT INTO channels (org,id,name,is_private,is_im,is_mpim,updated) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org,id) DO UPDATE SET name=EXCLUDED.name, is_private=EXCLUDED.is_private,
         is_im=EXCLUDED.is_im, is_mpim=EXCLUDED.is_mpim, updated=EXCLUDED.updated`,
      [org, c.id, c.name ?? null, !!c.is_private, !!c.is_im, !!c.is_mpim, Date.now()]);
  }
  async getChannel(org, id) { return (await this.pool.query('SELECT * FROM channels WHERE org=$1 AND id=$2', [org, id])).rows[0] || null; }

  async threadHydrated(org, channel, thread_ts) {
    return (await this.pool.query('SELECT 1 FROM threads WHERE org=$1 AND channel=$2 AND thread_ts=$3', [org, channel, thread_ts])).rowCount > 0;
  }
  async markThreadHydrated(org, channel, thread_ts) {
    await this.pool.query(`INSERT INTO threads (org,channel,thread_ts,hydrated_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (org,channel,thread_ts) DO UPDATE SET hydrated_at=EXCLUDED.hydrated_at`, [org, channel, thread_ts, Date.now()]);
  }

  async putToken(t) {
    await this.pool.query(
      `INSERT INTO tokens (org,team_name,token,cookie,user_id,updated) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org) DO UPDATE SET team_name=EXCLUDED.team_name, token=EXCLUDED.token,
         cookie=EXCLUDED.cookie, user_id=EXCLUDED.user_id, updated=EXCLUDED.updated`,
      [t.org, t.team_name ?? null, t.token, t.cookie, t.user_id ?? null, Date.now()]);
  }
  async getTokens() { return (await this.pool.query('SELECT * FROM tokens')).rows; }

  async putApp(a) {
    await this.pool.query(
      `INSERT INTO apps (org, app_id, team_id, team_name, bot_token, app_token, bot_user_id, bot_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org) DO UPDATE SET app_id=EXCLUDED.app_id, team_id=EXCLUDED.team_id,
         team_name=EXCLUDED.team_name, bot_token=EXCLUDED.bot_token, app_token=EXCLUDED.app_token,
         bot_user_id=EXCLUDED.bot_user_id, bot_id=EXCLUDED.bot_id`,
      [a.org, a.app_id, a.team_id, a.team_name, a.bot_token, a.app_token, a.bot_user_id, a.bot_id]);
  }
  async getApp(org) { return (await this.pool.query('SELECT * FROM apps WHERE org=$1', [org])).rows[0] || null; }
  async listApps() { return (await this.pool.query('SELECT * FROM apps')).rows; }

  // ---- keys: scoped consumer credentials (see keys.mjs — hash only, never raw key material) --
  async putKey(k) {
    await this.pool.query(
      `INSERT INTO keys (id,hash,label,orgs,created,last_used,revoked) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET hash=EXCLUDED.hash, label=EXCLUDED.label, orgs=EXCLUDED.orgs, revoked=EXCLUDED.revoked`,
      [k.id, k.hash, k.label ?? null, k.orgs ?? '*', k.created ?? Date.now(), k.last_used ?? null, !!k.revoked]);
  }
  async getKey(id) { return (await this.pool.query('SELECT * FROM keys WHERE id=$1', [id])).rows[0] || null; }
  async listKeys() { return (await this.pool.query('SELECT * FROM keys ORDER BY created DESC')).rows; }
  async touchKey(id) { await this.pool.query('UPDATE keys SET last_used=$2 WHERE id=$1', [id, Date.now()]); }
  async revokeKey(id) { return (await this.pool.query('UPDATE keys SET revoked=true WHERE id=$1', [id])).rowCount > 0; }

  // ---- key_requests: Slack-mediated key approval flow (see keyrequest.mjs) — same "hash/public
  // id only, never raw key material" contract as `keys` above. NOTE: this table has no
  // Postgres test coverage — the conventional test port (5440) is where a locally deployed hub's
  // database listens, so a test that fell back to it could reach real data (see docs/keys.md) — so this SQL is
  // covered by node --check + read-review against the sqlite/memory siblings instead, same as
  // `keys` itself (see test/keys-store.test.mjs's header for that precedent).
  async putKeyRequest(r) {
    await this.pool.query(
      `INSERT INTO key_requests (id,poll_hash,code,label,orgs,requester,status,created,expires_at,approver_org,dm_channel,decided_at,decided_by,key_id,delivered)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [r.id, r.poll_hash, r.code, r.label ?? '', r.orgs, r.requester ?? '', r.status ?? 'pending',
       r.created ?? Date.now(), r.expires_at, r.approver_org, r.dm_channel ?? null,
       r.decided_at ?? null, r.decided_by ?? null, r.key_id ?? null, !!r.delivered]);
  }
  async getKeyRequest(id) { return (await this.pool.query('SELECT * FROM key_requests WHERE id=$1', [id])).rows[0] || null; }
  async getPendingKeyRequestByCode(code) {
    return (await this.pool.query(`SELECT * FROM key_requests WHERE code=$1 AND status='pending' ORDER BY created DESC LIMIT 1`, [code])).rows[0] || null;
  }
  async listKeyRequests() { return (await this.pool.query('SELECT * FROM key_requests ORDER BY created DESC')).rows; }
  async countPendingKeyRequests(now = Date.now()) {
    return Number((await this.pool.query(`SELECT count(*) c FROM key_requests WHERE status='pending' AND expires_at > $1`, [now])).rows[0].c);
  }
  async claimKeyRequestApproval(id, { decided_by, decided_at }) {
    return (await this.pool.query(`UPDATE key_requests SET status='approved', decided_by=$2, decided_at=$3 WHERE id=$1 AND status='pending'`,
      [id, decided_by, decided_at])).rowCount > 0;
  }
  async setKeyRequestKeyId(id, key_id) { await this.pool.query('UPDATE key_requests SET key_id=$2 WHERE id=$1', [id, key_id]); }
  async denyKeyRequest(id, { decided_by, decided_at }) {
    return (await this.pool.query(`UPDATE key_requests SET status='denied', decided_by=$2, decided_at=$3 WHERE id=$1 AND status='pending'`,
      [id, decided_by, decided_at])).rowCount > 0;
  }
  async expireKeyRequest(id) {
    return (await this.pool.query(`UPDATE key_requests SET status='expired' WHERE id=$1 AND status='pending'`, [id])).rowCount > 0;
  }
  async revertKeyRequestToPending(id) {
    return (await this.pool.query(`UPDATE key_requests SET status='pending', key_id=NULL, decided_by=NULL, decided_at=NULL WHERE id=$1 AND status='approved'`, [id])).rowCount > 0;
  }
  async markKeyRequestDelivered(id) {
    return (await this.pool.query('UPDATE key_requests SET delivered=true WHERE id=$1 AND delivered=false', [id])).rowCount > 0;
  }

  async putOutbound(org, channel, ts) {
    await this.pool.query(`INSERT INTO outbound (org,channel,ts,at) VALUES ($1,$2,$3,$4) ON CONFLICT (org,channel,ts) DO NOTHING`,
      [org, channel, ts, Date.now()]);
  }
  async isOutbound(org, channel, ts) {
    return (await this.pool.query('SELECT 1 FROM outbound WHERE org=$1 AND channel=$2 AND ts=$3', [org, channel, ts])).rowCount > 0;
  }

  async setReaction(org, channel, ts, emoji, user, add = true) {
    const row = await this.getMessage(org, channel, ts);
    if (!row) return 0;                                  // reaction on a message we never ingested
    const r = (row.reactions && typeof row.reactions === 'object') ? row.reactions : {};
    const set = new Set(r[emoji] || []);
    add ? set.add(user) : set.delete(user);
    if (set.size) r[emoji] = [...set]; else delete r[emoji];
    await this.pool.query('UPDATE messages SET reactions=$4 WHERE org=$1 AND channel=$2 AND ts=$3', [org, channel, ts, JSON.stringify(r)]);
    return 1;
  }
  async markDeleted(org, channel, ts) {
    return (await this.pool.query('UPDATE messages SET deleted=true, deleted_at=$4 WHERE org=$1 AND channel=$2 AND ts=$3',
      [org, channel, ts, Date.now()])).rowCount;
  }
  async setLocalFiles(org, channel, ts, files_json) {
    await this.pool.query('UPDATE messages SET files_json=$4 WHERE org=$1 AND channel=$2 AND ts=$3', [org, channel, ts, files_json]);
  }

  async since(org, channels, sinceTs, limit = 1000) {
    if (!channels || !channels.length) return [];
    return (await this.pool.query(
      `SELECT * FROM messages WHERE org=$1 AND channel = ANY($2::text[]) AND ts > $3 ORDER BY ts ASC LIMIT $4`,
      [org, channels, sinceTs, limit])).rows;
  }

  async reconcileOutbound() {
    await this.pool.query("UPDATE messages m SET origin='hub' FROM outbound o WHERE m.org=o.org AND m.channel=o.channel AND m.ts=o.ts AND m.origin IS DISTINCT FROM 'hub'").catch(() => {});
  }
  async prune(retainMs) {
    return (await this.pool.query('DELETE FROM messages WHERE at < $1', [Date.now() - retainMs])).rowCount;
  }
  async stats() {
    const one = async (sql) => Number((await this.pool.query(sql)).rows[0].c);
    return {
      messages: await one('SELECT count(*) c FROM messages'),
      deleted: await one('SELECT count(*) c FROM messages WHERE deleted'),
      users: await one('SELECT count(*) c FROM users'),
      channels: await one('SELECT count(*) c FROM channels'),
      orgs: await one('SELECT count(*) c FROM tokens'),
    };
  }

  // ---- migration: bulk dump/load (see TABLE_DEF/rowValue above).
  // Keyset pagination (WHERE (pk...) > (last pk...) ORDER BY pk... LIMIT n) rather than
  // OFFSET — OFFSET re-scans everything before it on every page (O(n^2) over a large messages
  // table) and can skip or repeat rows if the table is written to mid-export; a row-value
  // comparison on the primary key has neither problem and is standard Postgres SQL. This is
  // also *the* mechanism satisfying "must stream/batch messages" for this backend: each page
  // is MIGRATE_BATCH rows, never the whole table, and pages are fetched lazily as the caller
  // consumes the generator.
  async *exportTable(name) {
    assertTable(name);
    const { pk } = TABLE_DEF[name];
    const tuple = qtuple(pk);
    let last = null;
    for (;;) {
      let text, values;
      if (last) {
        const ph = pk.map((_, i) => `$${i + 1}`).join(',');
        text = `SELECT * FROM ${name} WHERE ${tuple} > (${ph}) ORDER BY ${tuple} LIMIT $${pk.length + 1}`;
        values = [...last, MIGRATE_BATCH];
      } else {
        text = `SELECT * FROM ${name} ORDER BY ${tuple} LIMIT $1`;
        values = [MIGRATE_BATCH];
      }
      const { rows } = await this.pool.query(text, values);
      if (!rows.length) return;
      for (const r of rows) yield r;   // already portable — see rowValue's comment
      last = pk.map(c => rows[rows.length - 1][c]);
      if (rows.length < MIGRATE_BATCH) return;
    }
  }
  async importRows(name, rows) {
    assertTable(name);
    const { pk, cols } = TABLE_DEF[name];
    const updateCols = cols.filter(c => !pk.includes(c));
    const setClause = updateCols.map(c => `${qcol(c)}=EXCLUDED.${qcol(c)}`).join(', ');
    const insertSql = (rowCount) => {
      const tuples = [];
      for (let i = 0; i < rowCount; i++) tuples.push('(' + cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',') + ')');
      return `INSERT INTO ${name} (${cols.map(qcol).join(',')}) VALUES ${tuples.join(',')}
        ON CONFLICT (${pk.map(qcol).join(',')}) DO UPDATE SET ${setClause}`;
    };
    const client = await this.pool.connect();
    let n = 0, chunk = [];
    const flush = async () => {
      if (!chunk.length) return;
      const values = [];
      for (const row of chunk) for (const c of cols) values.push(rowValue(c, row));
      await client.query(insertSql(chunk.length), values);
      n += chunk.length; chunk = [];
    };
    try {
      await client.query('BEGIN');
      for await (const row of rows) { chunk.push(row); if (chunk.length >= MIGRATE_BATCH) await flush(); }
      await flush();
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    return n;
  }
}
