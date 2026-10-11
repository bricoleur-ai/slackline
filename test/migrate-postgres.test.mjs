// Real-Postgres coverage for exportTable/importRows/copyStores/verifyStores. migrate-store.test.mjs
// and migrate-file.test.mjs only exercise memory + sqlite::memory: because those need no
// external server; this file exercises the actual keyset-pagination SQL (row-value comparison,
// $n placeholder binding for a dynamic multi-row VALUES list, ON CONFLICT upsert) against a live
// Postgres — the SQL text can typecheck and still be wrong (e.g. a placeholder off-by-one in the
// multi-row batch builder) in a way only a real server catches.
//
// Bring up Postgres locally with the repo's own compose file: docker compose up -d postgres
// (same default connection string as db.mjs's own postgres:// fallback). Skips cleanly — the
// whole file, via a single reachability probe below — when no server answers, so `npm test`
// stays green with no Postgres running (CI, a fresh laptop, etc). Same pattern as
// test/store-apps-postgres.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../db.mjs';
import { copyStores, verifyStores } from '../migrate.mjs';

const PG_URL = process.env.SLACKLINE_TEST_PG_URL || process.env.DATABASE_URL
  || 'postgres://slackline:slackline@localhost:5440/slackline';

async function pgReachable(url) {
  let pg;
  try { ({ default: pg } = await import('pg')); } catch { return false; }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; }
  catch { try { await client.end(); } catch {} return false; }
}
const reachable = await pgReachable(PG_URL);
const skip = reachable ? false : `no Postgres reachable at ${PG_URL.replace(/:[^:@/]*@/, ':***@')} — start it with 'docker compose up -d postgres' to run this file`;

function hashOf(v) { return v == null ? null : `${createHash('sha256').update(String(v)).digest('hex')}:${String(v).length}`; }
async function drain(iter) { const out = []; for await (const r of iter) out.push(r); return out; }

// Every org/id below is namespaced pgmtest- so cleanup (in `finally`) can target it precisely
// without touching any other data that might be in this database.
const ORG = 'pgmtest-acme';
const SECRET_TOKEN = 'xoxc-pg-secret-session-token-AAAA';
const SECRET_COOKIE = 'd=xoxd-pg-secret-cookie-BBBB';
const BOT_TOKEN = 'xoxb-pg-secret-bot-token-CCCC';
const APP_TOKEN = 'xapp-pg-secret-app-token-DDDD';

async function cleanup(store) {
  for (const t of ['messages', 'threads', 'outbound']) await store.pool.query(`DELETE FROM ${t} WHERE org LIKE 'pgmtest-%'`).catch(() => {});
  for (const t of ['users', 'channels', 'tokens', 'apps']) await store.pool.query(`DELETE FROM ${t} WHERE org LIKE 'pgmtest-%'`).catch(() => {});
}

test('postgres: exportTable/importRows round-trips every table, including credentials by hash, and is idempotent', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    await cleanup(s);
    await s.putMessage({ org: ORG, channel: 'C1', ts: '1.100', thread_ts: '1.100', user: 'U1', text: 'hello',
      has_files: true, files_json: JSON.stringify([{ id: 'F1' }]), at: 1000 });
    await s.putMessage({ org: ORG, channel: 'C1', ts: '1.200', thread_ts: '1.100', user: 'U2', text: 'reply', at: 2000 });
    await s.setReaction(ORG, 'C1', '1.100', 'eyes', 'U2', true);
    await s.markDeleted(ORG, 'C1', '1.200');
    await s.putUser(ORG, { id: 'U1', name: 'alice', is_bot: false });
    await s.putChannel(ORG, { id: 'C1', name: 'general', is_private: true });
    await s.markThreadHydrated(ORG, 'C1', '1.100');
    await s.putOutbound(ORG, 'C1', '1.100');
    await s.putToken({ org: ORG, team_name: 'Acme', token: SECRET_TOKEN, cookie: SECRET_COOKIE, user_id: 'U1' });
    await s.putApp({ org: ORG, app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: BOT_TOKEN, app_token: APP_TOKEN, bot_user_id: 'UB', bot_id: 'BB' });

    for (const table of ['messages', 'users', 'channels', 'threads', 'outbound', 'tokens', 'apps']) {
      const rows = (await drain(s.exportTable(table))).filter(r => r.org === ORG);
      assert.ok(rows.length > 0, `${table}: expected at least one exported row`);
    }

    // sqlite::memory: as the destination — proves the portable row shape produced by real
    // Postgres JSONB/BOOLEAN columns (object/boolean straight off the wire, no coercion) is
    // exactly what sqlite's importRows expects (0/1 int, JSON text) after its own coercion.
    process.env.SLACKLINE_STORE = 'sqlite::memory:';
    const dst = createStore(); await dst.init();
    for (const table of ['messages', 'users', 'channels', 'threads', 'outbound', 'tokens', 'apps']) {
      const rows = (await drain(s.exportTable(table))).filter(r => r.org === ORG);
      const n1 = await dst.importRows(table, rows);
      const n2 = await dst.importRows(table, rows);   // idempotency
      assert.equal(n1, rows.length);
      assert.equal(n2, rows.length, `${table}: re-import must report the same count`);
    }
    const got = await dst.getMessage(ORG, 'C1', '1.100');
    assert.equal(got.text, 'hello');
    assert.deepEqual(got.reactions, { eyes: ['U2'] });
    const gotReply = await dst.getMessage(ORG, 'C1', '1.200');
    assert.equal(!!gotReply.deleted, true);
    const gotToken = (await dst.getTokens()).find(t => t.org === ORG);
    assert.equal(hashOf(gotToken.token), hashOf(SECRET_TOKEN));
    assert.equal(hashOf(gotToken.cookie), hashOf(SECRET_COOKIE));
    const gotApp = await dst.getApp(ORG);
    assert.equal(hashOf(gotApp.bot_token), hashOf(BOT_TOKEN));
    assert.equal(hashOf(gotApp.app_token), hashOf(APP_TOKEN));
  } finally {
    await cleanup(s);
    await s.pool.end();
  }
});

test('postgres: importRows paginates past a single batch (keyset pagination correctness) and stays idempotent', { skip }, async () => {
  const s = createStore(PG_URL); await s.init();
  try {
    await cleanup(s);
    const N = 1200;   // > MIGRATE_BATCH (500) so exportTable must page at least 3 times
    process.env.SLACKLINE_STORE = 'memory';
    const src = createStore(); await src.init();
    for (let i = 0; i < N; i++) await src.putMessage({ org: ORG, channel: 'C1', ts: `1.${String(i).padStart(6, '0')}`, user: 'U1', text: `m${i}`, at: i });

    const n1 = await s.importRows('messages', src.exportTable('messages'));
    const n2 = await s.importRows('messages', src.exportTable('messages'));   // re-run
    assert.equal(n1, N);
    assert.equal(n2, N, 're-importing the same generator output must not duplicate rows');

    const exported = (await drain(s.exportTable('messages'))).filter(r => r.org === ORG);
    assert.equal(exported.length, N, 'exportTable must page through the entire table, not stop at one batch');
    const tsSet = new Set(exported.map(r => r.ts));
    assert.equal(tsSet.size, N, 'every row must be distinct — keyset pagination must not skip or repeat rows across pages');
  } finally {
    await cleanup(s);
    await s.pool.end();
  }
});

test('postgres: copyStores + verifyStores round-trip memory -> postgres and report ok with matching credential hashes', { skip }, async () => {
  process.env.SLACKLINE_STORE = 'memory';
  const src = createStore(); await src.init();
  await src.putMessage({ org: ORG, channel: 'C1', ts: '1.1', user: 'U1', text: 'hi', at: 1 });
  await src.putToken({ org: ORG, team_name: 'Acme', token: SECRET_TOKEN, cookie: SECRET_COOKIE, user_id: 'U1' });
  await src.putApp({ org: ORG, app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: BOT_TOKEN, app_token: APP_TOKEN, bot_user_id: 'UB', bot_id: 'BB' });

  const dst = createStore(PG_URL); await dst.init();
  try {
    await cleanup(dst);
    await copyStores(src, dst, { tables: ['messages', 'tokens', 'apps'] });
    await copyStores(src, dst, { tables: ['messages', 'tokens', 'apps'] });   // idempotency

    // Postgres here is a live server this suite doesn't own exclusively — `node --test` can run
    // other *-postgres.test.mjs files concurrently against the same database, so a whole-table
    // row count (verifyStores' drift/`ok`) could include other suites' unrelated rows. Only the
    // credentials map is safe to assert on unconditionally: it's keyed per-org, and ORG is
    // namespaced to this file alone.
    const r = await verifyStores(src, dst, { tables: ['tokens', 'apps'] });
    assert.equal(r.tables.tokens.credentials[ORG].token, 'match');
    assert.equal(r.tables.tokens.credentials[ORG].cookie, 'match');
    assert.equal(r.tables.apps.credentials[ORG].bot_token, 'match');
    assert.equal(r.tables.apps.credentials[ORG].app_token, 'match');
    // Message content is checked directly by primary-key lookup (org+channel+ts-scoped), not
    // via an aggregate count, for the same shared-server reason.
    const gotMsg = await dst.getMessage(ORG, 'C1', '1.1');
    assert.equal(gotMsg.text, 'hi');
  } finally {
    await cleanup(dst);
    await dst.pool.end();
  }
});
