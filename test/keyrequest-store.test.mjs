import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../db.mjs';

// Direct store-level coverage for the key_requests table (see keyrequest.mjs), added alongside
// `keys`. Same scope/rationale as test/keys-store.test.mjs: memory + sqlite::memory: only — no
// Postgres variant here either: the conventional test port (5440) is where a locally deployed
// hub's database listens, so a test that fell back to it could reach real data (see docs/keys.md);
// stores/postgres.mjs's key_requests SQL is covered by node --check + read-review against these
// two siblings instead.

const sample = { id: 'req1', poll_hash: 'a'.repeat(64), code: 'ABCD23', label: 'ci agent', orgs: 'acme',
  requester: 'ci-runner-7', status: 'pending', created: 1000, expires_at: 1000 + 600000, approver_org: 'acme' };

for (const backend of ['memory', 'sqlite::memory:']) {
  test(`${backend}: round-trips a key request row`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    const got = await s.getKeyRequest('req1');
    assert.equal(got.poll_hash, 'a'.repeat(64));
    assert.equal(got.code, 'ABCD23');
    assert.equal(got.label, 'ci agent');
    assert.equal(got.orgs, 'acme');
    assert.equal(got.requester, 'ci-runner-7');
    assert.equal(got.status, 'pending');
    assert.equal(got.approver_org, 'acme');
    assert.equal(got.dm_channel, null);
    assert.equal(got.key_id, null);
    assert.ok(!got.delivered);
  });

  test(`${backend}: getKeyRequest returns null for an unknown id`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    assert.equal(await s.getKeyRequest('nope'), null);
  });

  test(`${backend}: getPendingKeyRequestByCode finds a pending row by code, ignores non-pending ones`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    const found = await s.getPendingKeyRequestByCode('ABCD23');
    assert.equal(found.id, 'req1');
    await s.denyKeyRequest('req1', { decided_by: 'U1', decided_at: 2000 });
    assert.equal(await s.getPendingKeyRequestByCode('ABCD23'), null);
  });

  test(`${backend}: getPendingKeyRequestByCode picks the newest when codes collide`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest({ ...sample, id: 'old', created: 1000 });
    await s.putKeyRequest({ ...sample, id: 'new', created: 2000 });
    const found = await s.getPendingKeyRequestByCode('ABCD23');
    assert.equal(found.id, 'new');
  });

  test(`${backend}: countPendingKeyRequests counts only pending rows still inside their expiry window`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    const now = 10_000;
    await s.putKeyRequest({ ...sample, id: 'live', expires_at: now + 1000 });
    await s.putKeyRequest({ ...sample, id: 'timedout', code: 'ZZZZ99', expires_at: now - 1000 }); // pending but past expiry
    await s.putKeyRequest({ ...sample, id: 'approved', code: 'YYYY88', status: 'approved', expires_at: now + 1000 });
    assert.equal(await s.countPendingKeyRequests(now), 1);
  });

  test(`${backend}: claimKeyRequestApproval flips pending->approved exactly once`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    assert.equal(await s.claimKeyRequestApproval('req1', { decided_by: 'U1', decided_at: 5000 }), true);
    const got = await s.getKeyRequest('req1');
    assert.equal(got.status, 'approved');
    assert.equal(got.decided_by, 'U1');
    assert.equal(got.decided_at, 5000);
    // Idempotency: a second claim on an already-approved row must report failure, not re-approve.
    assert.equal(await s.claimKeyRequestApproval('req1', { decided_by: 'U2', decided_at: 6000 }), false);
    assert.equal((await s.getKeyRequest('req1')).decided_by, 'U1');
  });

  test(`${backend}: setKeyRequestKeyId records the key's public id only`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    await s.setKeyRequestKeyId('req1', 'pubkeyid123');
    assert.equal((await s.getKeyRequest('req1')).key_id, 'pubkeyid123');
  });

  test(`${backend}: denyKeyRequest is idempotent the same way claimKeyRequestApproval is`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    assert.equal(await s.denyKeyRequest('req1', { decided_by: 'U1', decided_at: 5000 }), true);
    assert.equal(await s.denyKeyRequest('req1', { decided_by: 'U1', decided_at: 6000 }), false);
    assert.equal((await s.getKeyRequest('req1')).status, 'denied');
  });

  test(`${backend}: expireKeyRequest only affects a still-pending row`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    assert.equal(await s.expireKeyRequest('req1'), true);
    assert.equal((await s.getKeyRequest('req1')).status, 'expired');
    assert.equal(await s.expireKeyRequest('req1'), false);
  });

  test(`${backend}: revertKeyRequestToPending undoes a claim (createKey-failure rollback path)`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    await s.claimKeyRequestApproval('req1', { decided_by: 'U1', decided_at: 5000 });
    await s.setKeyRequestKeyId('req1', 'shouldnotsurvive');
    assert.equal(await s.revertKeyRequestToPending('req1'), true);
    const got = await s.getKeyRequest('req1');
    assert.equal(got.status, 'pending');
    assert.equal(got.key_id, null);
    assert.equal(got.decided_by, null);
    // Only fires from 'approved' — a plain pending row has nothing to revert.
    assert.equal(await s.revertKeyRequestToPending('req1'), false);
  });

  test(`${backend}: markKeyRequestDelivered is a single-use flag`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest(sample);
    assert.equal(await s.markKeyRequestDelivered('req1'), true);
    assert.ok((await s.getKeyRequest('req1')).delivered);
    assert.equal(await s.markKeyRequestDelivered('req1'), false); // already delivered — no second grant
  });

  test(`${backend}: listKeyRequests returns every row, newest first`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putKeyRequest({ ...sample, id: 'a', created: 1000 });
    await s.putKeyRequest({ ...sample, id: 'b', code: 'EFGH34', created: 2000 });
    const rows = await s.listKeyRequests();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'b');
  });
}
