import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../db.mjs';

// Direct store-level coverage for putKey/getKey/listKeys/touchKey/revokeKey — the `keys` table
// added alongside the existing seven (messages/users/channels/threads/outbound/tokens/apps).
// Same scope as store-apps.test.mjs: memory + sqlite::memory: only, since neither needs an
// external server. (A Postgres variant is deliberately not included here: the conventional test
// port (5440) is where a locally deployed hub's database listens, so a test that fell back to
// it could reach real data — see docs/keys.md — so postgres.mjs's SQL is covered by node --check + read-review instead.)

const sample = { id: 'abc123def456', hash: 'a'.repeat(64), label: 'laptop agent', orgs: 'acme', created: 1000, last_used: null, revoked: false };

for (const backend of ['memory', 'sqlite::memory:']) {
  test(`${backend}: round-trips a key row`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKey(sample);
    const got = await s.getKey('abc123def456');
    assert.equal(got.hash, 'a'.repeat(64));
    assert.equal(got.label, 'laptop agent');
    assert.equal(got.orgs, 'acme');
    assert.equal(got.created, 1000);
    assert.equal(got.last_used, null);
    assert.ok(!got.revoked);
  });

  test(`${backend}: getKey returns null for an unknown id`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    assert.equal(await s.getKey('nope'), null);
  });

  test(`${backend}: putKey upserts rather than duplicating`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKey(sample);
    await s.putKey({ ...sample, label: 'renamed', orgs: '*' });
    assert.equal((await s.listKeys()).length, 1);
    const got = await s.getKey('abc123def456');
    assert.equal(got.label, 'renamed');
    assert.equal(got.orgs, '*');
  });

  test(`${backend}: touchKey stamps last_used`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKey(sample);
    assert.equal((await s.getKey('abc123def456')).last_used, null);
    await s.touchKey('abc123def456');
    const got = await s.getKey('abc123def456');
    assert.ok(typeof got.last_used === 'number' && got.last_used > 0);
  });

  test(`${backend}: revokeKey flips the flag and reports whether a row was found`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKey(sample);
    assert.equal(await s.revokeKey('nonexistent'), false);
    assert.equal(await s.revokeKey('abc123def456'), true);
    const got = await s.getKey('abc123def456');
    assert.ok(got.revoked);
  });

  test(`${backend}: listKeys returns every row, including the hash (keys.mjs, not the store, is what filters it for CLI output)`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKey(sample);
    await s.putKey({ ...sample, id: 'zzz999', label: 'admin', orgs: '*' });
    const rows = await s.listKeys();
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => typeof r.hash === 'string' && r.hash.length === 64));
  });
}
