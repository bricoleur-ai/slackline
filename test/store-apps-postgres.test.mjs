// Real-Postgres coverage for putApp/getApp/listApps. store-apps.test.mjs only exercises
// memory + sqlite::memory: because those need no external server; this file exercises the
// actual SQL against a live Postgres, which is the only way to catch things reading the SQL
// cannot: $n placeholder binding, ON CONFLICT upsert semantics, rows[0] || null returning
// null (not undefined), and column/value order (a transposed bot_token/app_token would only
// ever surface against a real server, since the SQLite mirror shares the same bug if present).
//
// Bring up Postgres locally with the repo's own compose file:  docker compose up -d postgres
// (uses the same default connection string as db.mjs's own postgres:// fallback, so no .env
// edits are required just to run this suite). Skips cleanly — the whole file, via a single
// reachability probe below — when no server answers, so `npm test` stays green with no
// Postgres running (CI, a fresh laptop, etc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../db.mjs';

const PG_URL = process.env.SLACKLINE_TEST_PG_URL || process.env.DATABASE_URL
  || 'postgres://slackline:slackline@localhost:5440/slackline';

async function pgReachable(url) {
  let pg;
  try { ({ default: pg } = await import('pg')); } catch { return false; }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { try { await client.end(); } catch {} return false; }
}
// One probe for the whole file rather than per-test — a dead server should fail fast once,
// not add a ~1.5s timeout to every test in the file.
const reachable = await pgReachable(PG_URL);
const skip = reachable ? false : `no Postgres reachable at ${PG_URL.replace(/:[^:@/]*@/, ':***@')} — start it with 'docker compose up -d postgres' to run this file`;

// Distinct values per field (not just distinct per row) so a column/value transposition
// between bot_token and app_token — which would only fail against a live Slack call, never
// against the SQL text — fails this assertion instead.
const sample = { org: 'pgtest-acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme',
  bot_token: 'xoxb-BOT-TOKEN', app_token: 'xapp-APP-TOKEN', bot_user_id: 'UBOT', bot_id: 'BBOT' };

test('postgres: round-trips an app credential without transposing bot_token/app_token', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    await s.putApp(sample);
    const got = await s.getApp(sample.org);
    assert.equal(got.app_id, 'A1');
    assert.equal(got.team_id, 'T1');
    assert.equal(got.team_name, 'Acme');
    assert.equal(got.bot_token, 'xoxb-BOT-TOKEN');   // would read xapp-APP-TOKEN if columns were swapped
    assert.equal(got.app_token, 'xapp-APP-TOKEN');   // would read xoxb-BOT-TOKEN if columns were swapped
    assert.equal(got.bot_user_id, 'UBOT');
    assert.equal(got.bot_id, 'BBOT');
  } finally {
    await s.pool.query('DELETE FROM apps WHERE org = $1', [sample.org]);
    await s.pool.end();
  }
});

test('postgres: getApp returns null (not undefined) for an unknown org', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    const got = await s.getApp('pgtest-does-not-exist');
    assert.equal(got, null);
    assert.notEqual(got, undefined);   // rows[0] || null must coerce undefined -> null
  } finally { await s.pool.end(); }
});

test('postgres: putApp upserts on ON CONFLICT (org) rather than duplicating rows', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    await s.putApp(sample);
    await s.putApp({ ...sample, bot_token: 'xoxb-ROTATED', app_token: 'xapp-ROTATED' });
    const rows = (await s.listApps()).filter(a => a.org === sample.org);
    assert.equal(rows.length, 1);
    const got = await s.getApp(sample.org);
    assert.equal(got.bot_token, 'xoxb-ROTATED');
    assert.equal(got.app_token, 'xapp-ROTATED');
  } finally {
    await s.pool.query('DELETE FROM apps WHERE org = $1', [sample.org]);
    await s.pool.end();
  }
});

test('postgres: listApps returns every stored app', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    await s.putApp(sample);
    await s.putApp({ ...sample, org: 'pgtest-other', app_id: 'A2', bot_token: 'xoxb-OTHER', app_token: 'xapp-OTHER' });
    const orgs = (await s.listApps()).map(a => a.org);
    assert.ok(orgs.includes('pgtest-acme'));
    assert.ok(orgs.includes('pgtest-other'));
  } finally {
    await s.pool.query('DELETE FROM apps WHERE org = ANY($1::text[])', [[sample.org, 'pgtest-other']]);
    await s.pool.end();
  }
});

// CREATE TABLE IF NOT EXISTS only helps if it actually runs again on an existing database —
// simulates a pre-app-mode deployment (apps table absent) picking up the feature on next boot,
// without losing unrelated data already in the database.
test('postgres: CREATE TABLE IF NOT EXISTS migrates an existing database without data loss', { skip }, async () => {
  const s1 = createStore(PG_URL); await s1.init();
  try {
    await s1.pool.query('DROP TABLE IF EXISTS apps');
    await s1.putMessage({ org: 'pgtest-migrate', channel: 'C1', ts: '1.1', text: 'pre-existing', at: Date.now() });

    const s2 = createStore(PG_URL); await s2.init();   // fresh store instance = fresh process boot
    try {
      const msg = await s2.getMessage('pgtest-migrate', 'C1', '1.1');
      assert.equal(msg && msg.text, 'pre-existing');   // untouched by the migration

      await s2.putApp({ ...sample, org: 'pgtest-migrate' });
      const got = await s2.getApp('pgtest-migrate');
      assert.equal(got.app_id, 'A1');
    } finally { await s2.pool.end(); }
  } finally {
    await s1.pool.query('DELETE FROM messages WHERE org = $1', ['pgtest-migrate']).catch(() => {});
    await s1.pool.query('DELETE FROM apps WHERE org = $1', ['pgtest-migrate']).catch(() => {});
    await s1.pool.end();
  }
});
