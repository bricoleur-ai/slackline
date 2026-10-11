// Coverage for migrate.mjs's file/orchestration layer: exportToFile, importFromFile,
// copyStores, verifyStores. Uses memory + sqlite::memory: stores only (no external server) and
// a throwaway temp dir for ndjson files — never touches the live systemd-managed
// ~/.slackline/demo.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../db.mjs';
import { exportToFile, importFromFile, copyStores, verifyStores, resolveTables, TABLES } from '../migrate.mjs';

const SECRET_TOKEN = 'xoxc-9-highly-secret-session-token-ZZZZ9999';
const SECRET_COOKIE = 'd=xoxd-highly-secret-cookie-value-YYYY8888';
const BOT_TOKEN = 'xoxb-highly-secret-bot-token-WWWW7777';
const APP_TOKEN = 'xapp-highly-secret-app-token-VVVV6666';

async function seededStore(spec) {
  process.env.SLACKLINE_STORE = spec;
  const s = createStore(); await s.init();
  await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.100', thread_ts: '1.100', user: 'U1', text: 'hello', at: 1 });
  await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.200', thread_ts: '1.100', user: 'U2', text: 'reply', at: 2,
    has_files: true, files_json: JSON.stringify([{ id: 'F1' }]) });
  await s.setReaction('acme', 'C1', '1.100', 'eyes', 'U2', true);
  await s.putUser('acme', { id: 'U1', name: 'alice', is_bot: false });
  await s.putUser('acme', { id: 'U2', name: 'bob', is_bot: false });
  await s.putChannel('acme', { id: 'C1', name: 'general', is_private: false });
  await s.markThreadHydrated('acme', 'C1', '1.100');
  await s.putOutbound('acme', 'C1', '1.100');
  await s.putToken({ org: 'acme', team_name: 'Acme', token: SECRET_TOKEN, cookie: SECRET_COOKIE, user_id: 'U1' });
  await s.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: BOT_TOKEN, app_token: APP_TOKEN, bot_user_id: 'UB', bot_id: 'BB' });
  return s;
}

function tmpFile(dir, name) { return path.join(dir, name); }

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-migrate-test-'));
  return (async () => { try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } })();
}

test('resolveTables: defaults to every table, rejects unknown names', () => {
  assert.deepEqual(resolveTables(), TABLES);
  assert.deepEqual(resolveTables(['messages']), ['messages']);
  assert.throws(() => resolveTables(['bogus']), /unknown table/);
});

test('exportToFile writes an ndjson file with mode 0600 (credentials must never be world/group readable)', async () => {
  await withTmpDir(async (dir) => {
    const s = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    const r = await exportToFile(s, { out });
    assert.equal(r.tables.messages, 2);
    assert.equal(r.tables.tokens, 1);
    assert.equal(r.tables.apps, 1);
    const mode = statSync(out).mode & 0o777;
    assert.equal(mode, 0o600, `expected file mode 0600, got 0${mode.toString(8)}`);
  });
});

test('exportToFile result object never contains the raw token/cookie/app-token values', async () => {
  await withTmpDir(async (dir) => {
    const s = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    const r = await exportToFile(s, { out });
    const serialized = JSON.stringify(r);
    for (const secret of [SECRET_TOKEN, SECRET_COOKIE, BOT_TOKEN, APP_TOKEN]) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

test('exportToFile --dry-run reports counts without creating a file', async () => {
  await withTmpDir(async (dir) => {
    const s = await seededStore('memory');
    const out = tmpFile(dir, 'should-not-exist.ndjson');
    const r = await exportToFile(s, { out, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.tables.messages, 2);
    assert.throws(() => statSync(out));
  });
});

test('export -> import round-trips all seven tables into a fresh store, including credentials by hash', async () => {
  await withTmpDir(async (dir) => {
    const src = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    await exportToFile(src, { out });

    const dst = await (async () => { process.env.SLACKLINE_STORE = 'sqlite::memory:'; const s = createStore(); await s.init(); return s; })();
    const r = await importFromFile(dst, { in: out });
    assert.equal(r.tables.messages, 2);
    assert.equal(r.tables.users, 2);
    assert.equal(r.tables.channels, 1);
    assert.equal(r.tables.threads, 1);
    assert.equal(r.tables.outbound, 1);
    assert.equal(r.tables.tokens, 1);
    assert.equal(r.tables.apps, 1);

    const verified = await verifyStores(src, dst, {});
    assert.equal(verified.ok, true, JSON.stringify(verified));
    for (const t of Object.values(verified.tables)) assert.equal(t.drift, 0);
    assert.equal(verified.tables.tokens.credentials.acme.token, 'match');
    assert.equal(verified.tables.tokens.credentials.acme.cookie, 'match');
    assert.equal(verified.tables.apps.credentials.acme.bot_token, 'match');
    assert.equal(verified.tables.apps.credentials.acme.app_token, 'match');
  });
});

test('importFromFile is idempotent — importing the same file twice does not duplicate rows', async () => {
  await withTmpDir(async (dir) => {
    const src = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    await exportToFile(src, { out });

    process.env.SLACKLINE_STORE = 'sqlite::memory:';
    const dst = createStore(); await dst.init();
    const r1 = await importFromFile(dst, { in: out });
    const r2 = await importFromFile(dst, { in: out });
    assert.deepEqual(r1.tables, r2.tables);
    const stats = await dst.stats();
    assert.equal(stats.messages, 2, 're-importing must not duplicate messages');
    assert.equal(stats.orgs, 1, 're-importing must not duplicate the tokens row');
  });
});

test('importFromFile --tables restricts which tables load', async () => {
  await withTmpDir(async (dir) => {
    const src = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    await exportToFile(src, { out });

    process.env.SLACKLINE_STORE = 'sqlite::memory:';
    const dst = createStore(); await dst.init();
    const r = await importFromFile(dst, { in: out, tables: ['users', 'channels'] });
    assert.deepEqual(Object.keys(r.tables).sort(), ['channels', 'users']);
    const stats = await dst.stats();
    assert.equal(stats.messages, 0);
    assert.equal(stats.orgs, 0);
    assert.equal(stats.users, 2);
  });
});

test('importFromFile --dry-run reports counts without writing to the store', async () => {
  await withTmpDir(async (dir) => {
    const src = await seededStore('memory');
    const out = tmpFile(dir, 'dump.ndjson');
    await exportToFile(src, { out });

    process.env.SLACKLINE_STORE = 'sqlite::memory:';
    const dst = createStore(); await dst.init();
    const r = await importFromFile(dst, { in: out, dryRun: true });
    assert.equal(r.tables.messages, 2);
    const stats = await dst.stats();
    assert.equal(stats.messages, 0, 'dry-run must not write anything');
  });
});

test('copyStores: direct store-to-store copy with no intermediate file, idempotent on re-run', async () => {
  const src = await seededStore('memory');
  process.env.SLACKLINE_STORE = 'sqlite::memory:';
  const dst = createStore(); await dst.init();

  const r1 = await copyStores(src, dst, {});
  const r2 = await copyStores(src, dst, {});   // re-run
  assert.deepEqual(r1.tables, r2.tables);
  const stats = await dst.stats();
  assert.equal(stats.messages, 2);
  assert.equal(stats.orgs, 1);

  const verified = await verifyStores(src, dst, {});
  assert.equal(verified.ok, true, JSON.stringify(verified));
});

test('copyStores --tables restricts which tables copy; --dry-run copies nothing', async () => {
  const src = await seededStore('memory');
  process.env.SLACKLINE_STORE = 'sqlite::memory:';
  const dst1 = createStore(); await dst1.init();
  await copyStores(src, dst1, { tables: ['messages'] });
  const stats1 = await dst1.stats();
  assert.equal(stats1.messages, 2);
  assert.equal(stats1.users, 0);

  const dst2 = createStore(); await dst2.init();
  const dry = await copyStores(src, dst2, { dryRun: true });
  assert.equal(dry.tables.messages, 2);
  const stats2 = await dst2.stats();
  assert.equal(stats2.messages, 0, 'dry-run must not write to the destination');
});

test('verifyStores reports drift when row counts differ, without touching credential contents', async () => {
  const src = await seededStore('memory');
  process.env.SLACKLINE_STORE = 'sqlite::memory:';
  const dst = createStore(); await dst.init();
  await copyStores(src, dst, {});
  // introduce drift: one more message on the source than the destination has
  await src.putMessage({ org: 'acme', channel: 'C1', ts: '1.300', user: 'U1', text: 'unsynced', at: 3 });

  const r = await verifyStores(src, dst, {});
  assert.equal(r.ok, false);
  assert.equal(r.tables.messages.from, 3);
  assert.equal(r.tables.messages.to, 2);
  assert.equal(r.tables.messages.drift, 1);
  const serialized = JSON.stringify(r);
  for (const secret of [SECRET_TOKEN, SECRET_COOKIE, BOT_TOKEN, APP_TOKEN]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('verifyStores catches a mangled credential (mismatch), not just a row-count match', async () => {
  const src = await seededStore('memory');
  process.env.SLACKLINE_STORE = 'sqlite::memory:';
  const dst = createStore(); await dst.init();
  await copyStores(src, dst, {});
  // Simulate a transposed/corrupted token landing at the destination — same row count as
  // source, so a naive count-only verify would miss this entirely.
  await dst.putToken({ org: 'acme', team_name: 'Acme', token: 'xoxc-CORRUPTED', cookie: SECRET_COOKIE, user_id: 'U1' });

  const r = await verifyStores(src, dst, {});
  assert.equal(r.ok, false);
  assert.equal(r.tables.tokens.drift, 0, 'row count still matches — only the content is wrong');
  assert.equal(r.tables.tokens.credentials.acme.token, 'mismatch');
  assert.equal(r.tables.tokens.credentials.acme.cookie, 'match');
});
