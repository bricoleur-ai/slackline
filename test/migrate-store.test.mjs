// Direct coverage of exportTable/importRows on each store (memory, sqlite::memory:) — the two
// backends that need no external server, so this file always runs. Real-Postgres coverage of
// the same interface lives in migrate-postgres.test.mjs and skips cleanly with no server up.
//
// What this file proves per backend, and across backends:
//  - exportTable yields the portable row shape (booleans as true/false, JSON columns as
//    objects) documented in migrate.mjs, for all seven tables.
//  - importRows is a faithful full-column upsert keyed on each table's natural PK — re-running
//    it twice must not duplicate rows (idempotency is a hard requirement).
//  - a row exported from one backend imports cleanly into a *different* backend (memory <->
//    sqlite) — proving the row shape is actually portable, not just self-consistent.
//  - credential fields (tokens.token/cookie, apps.bot_token/app_token) round-trip byte-for-byte
//    — checked by length + sha256 hash, never by asserting on the raw value (see hashOf below;
//    same reasoning as the "never log/print/write token values" rule in migrate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../db.mjs';

function hashOf(v) { return v == null ? null : `${createHash('sha256').update(String(v)).digest('hex')}:${String(v).length}`; }

async function freshStore(backend) {
  process.env.SLACKLINE_STORE = backend;
  const s = createStore(); await s.init();
  return s;
}

async function drain(iter) { const out = []; for await (const r of iter) out.push(r); return out; }

const BACKENDS = ['memory', 'sqlite::memory:'];

for (const backend of BACKENDS) {
  test(`${backend}: exportTable/importRows round-trips messages (booleans, files_json, reactions, deletion)`, async () => {
    const s = await freshStore(backend);
    await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.100', thread_ts: '1.100', user: 'U1', text: 'hello',
      has_files: true, files_json: JSON.stringify([{ id: 'F1', name: 'shot.png' }]), at: 1000 });
    await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.200', thread_ts: '1.100', user: 'U2', text: 'reply', at: 2000 });
    await s.setReaction('acme', 'C1', '1.100', 'thumbsup', 'U2', true);
    await s.markDeleted('acme', 'C1', '1.200');

    const rows = await drain(s.exportTable('messages'));
    assert.equal(rows.length, 2);
    const root = rows.find(r => r.ts === '1.100');
    assert.equal(root.has_files, true);
    assert.deepEqual(root.files_json, [{ id: 'F1', name: 'shot.png' }]);
    assert.deepEqual(root.reactions, { thumbsup: ['U2'] });
    assert.equal(root.deleted, false);
    const reply = rows.find(r => r.ts === '1.200');
    assert.equal(reply.deleted, true);
    assert.equal(typeof reply.deleted_at, 'number');

    const dst = await freshStore(backend === 'memory' ? 'sqlite::memory:' : 'memory');   // cross-backend
    const n = await dst.importRows('messages', rows);
    assert.equal(n, 2);
    const got = await dst.getMessage('acme', 'C1', '1.100');
    assert.equal(got.text, 'hello');
    assert.deepEqual(got.reactions.thumbsup.sort(), ['U2']);
    const gotReply = await dst.getMessage('acme', 'C1', '1.200');
    assert.equal(!!gotReply.deleted, true);
  });

  test(`${backend}: exportTable/importRows round-trips users/channels boolean flags`, async () => {
    const s = await freshStore(backend);
    await s.putUser('acme', { id: 'U1', name: 'alice', real_name: 'Alice A', is_bot: true });
    await s.putChannel('acme', { id: 'C1', name: 'general', is_private: true, is_im: false, is_mpim: false });

    const users = await drain(s.exportTable('users'));
    const channels = await drain(s.exportTable('channels'));
    assert.equal(users[0].is_bot, true);
    assert.equal(channels[0].is_private, true);
    assert.equal(channels[0].is_im, false);

    const dst = await freshStore(backend === 'memory' ? 'sqlite::memory:' : 'memory');
    await dst.importRows('users', users);
    await dst.importRows('channels', channels);
    assert.equal((await dst.getUser('acme', 'U1')).name, 'alice');
    assert.equal((await dst.getChannel('acme', 'C1')).name, 'general');
  });

  test(`${backend}: exportTable/importRows round-trips threads/outbound INCLUDING the original timestamp`, async () => {
    const s = await freshStore(backend);
    await s.markThreadHydrated('acme', 'C1', '1.100');
    await s.putOutbound('acme', 'C1', '1.200');
    const threads = await drain(s.exportTable('threads'));
    const outbound = await drain(s.exportTable('outbound'));
    assert.equal(threads[0].thread_ts, '1.100');
    assert.equal(typeof threads[0].hydrated_at, 'number');
    assert.equal(outbound[0].ts, '1.200');
    assert.equal(typeof outbound[0].at, 'number');

    // importRows must preserve the *source* timestamp, not fabricate a new "now" — a fresh
    // markThreadHydrated()/putOutbound() call would stamp Date.now() instead, which is exactly
    // the bug a raw pass-through import would introduce.
    const dst = await freshStore(backend === 'memory' ? 'sqlite::memory:' : 'memory');
    const oldTs = 12345;
    await dst.importRows('threads', [{ org: 'acme', channel: 'C1', thread_ts: '1.100', hydrated_at: oldTs }]);
    await dst.importRows('outbound', [{ org: 'acme', channel: 'C1', ts: '1.200', at: oldTs }]);
    const gotThreads = await drain(dst.exportTable('threads'));
    const gotOutbound = await drain(dst.exportTable('outbound'));
    assert.equal(gotThreads[0].hydrated_at, oldTs);
    assert.equal(gotOutbound[0].at, oldTs);
  });

  test(`${backend}: credential fields (tokens/apps) round-trip byte-for-byte across a cross-backend copy`, async () => {
    const s = await freshStore(backend);
    const token = 'xoxc-9-super-secret-session-token-AAAA1111';
    const cookie = 'd=xoxd-super-secret-cookie-value-BBBB2222';
    const botToken = 'xoxb-bot-token-CCCC3333';
    const appToken = 'xapp-app-token-DDDD4444';
    await s.putToken({ org: 'acme', team_name: 'Acme', token, cookie, user_id: 'U1' });
    await s.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: botToken, app_token: appToken, bot_user_id: 'UB', bot_id: 'BB' });

    const tokens = await drain(s.exportTable('tokens'));
    const apps = await drain(s.exportTable('apps'));
    const dst = await freshStore(backend === 'memory' ? 'sqlite::memory:' : 'memory');
    await dst.importRows('tokens', tokens);
    await dst.importRows('apps', apps);

    const gotTokens = await drain(dst.exportTable('tokens'));
    const gotApps = await drain(dst.exportTable('apps'));
    // Compare by hash+length, never by asserting the raw string directly — matches migrate.mjs's
    // own "never log/print/write token values" rule (an assert.equal failure message would
    // otherwise print both operands verbatim).
    assert.equal(hashOf(gotTokens[0].token), hashOf(token));
    assert.equal(hashOf(gotTokens[0].cookie), hashOf(cookie));
    assert.equal(hashOf(gotApps[0].bot_token), hashOf(botToken));
    assert.equal(hashOf(gotApps[0].app_token), hashOf(appToken));
  });

  test(`${backend}: importRows is idempotent — re-running the same rows twice does not duplicate`, async () => {
    const s = await freshStore(backend);
    await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.100', user: 'U1', text: 'hi', at: 1 });
    await s.putUser('acme', { id: 'U1', name: 'alice' });
    await s.putChannel('acme', { id: 'C1', name: 'general' });
    await s.markThreadHydrated('acme', 'C1', '1.100');
    await s.putOutbound('acme', 'C1', '1.100');
    await s.putToken({ org: 'acme', team_name: 'T', token: 'xoxc-A', cookie: 'd=B', user_id: 'U1' });
    await s.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'T', bot_token: 'xoxb-A', app_token: 'xapp-A', bot_user_id: 'UB', bot_id: 'BB' });

    const dst = await freshStore(backend);
    for (const table of ['messages', 'users', 'channels', 'threads', 'outbound', 'tokens', 'apps']) {
      const rows = await drain(s.exportTable(table));
      const n1 = await dst.importRows(table, rows);
      const n2 = await dst.importRows(table, rows);   // re-run
      assert.equal(n1, rows.length);
      assert.equal(n2, rows.length, `${table}: importRows should report the same row count on a re-run`);
      const after = await drain(dst.exportTable(table));
      assert.equal(after.length, rows.length, `${table}: re-running import must not duplicate rows`);
    }
  });

  test(`${backend}: exportTable rejects an unknown table name`, async () => {
    const s = await freshStore(backend);
    await assert.rejects(async () => { for await (const _ of s.exportTable('bogus')) {} });
  });

  test(`${backend}: importRows accepts an async generator directly (no array buffering required)`, async () => {
    const s = await freshStore(backend);
    for (let i = 0; i < 50; i++) await s.putMessage({ org: 'acme', channel: 'C1', ts: `1.${i}`, user: 'U1', text: `m${i}`, at: i });
    const dst = await freshStore(backend);
    // Pass exportTable's own async generator straight into importRows, same as copyStores does
    // in migrate.mjs — proves the interface streams end-to-end, not just when pre-collected.
    const n = await dst.importRows('messages', s.exportTable('messages'));
    assert.equal(n, 50);
    assert.equal((await dst.recent('acme', 'C1', 100)).length, 50);
  });
}
