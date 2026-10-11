import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createKeyRequestManager } from '../keyrequest.mjs';
import { MemoryStore } from '../stores/memory.mjs';
import { listKeys } from '../keys.mjs';

// Manager-level coverage: exercises createKeyRequestManager() directly (no HTTP layer — see
// test/keyrequest-api.test.mjs for that), stubbing globalThis.fetch the same way
// test/keys-api.test.mjs's /say-/react test does, since slack.mjs's api() is a thin wrapper over
// fetch() and ESM named exports can't be monkeypatched directly. NEVER a real Slack call here.

const APPROVER = 'UAPPROVER';
const OTHER_USER = 'USOMEONEELSE';
const ORG = 'acme';
const CHANNEL = 'D_APPROVER_DM';

function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    const method = String(url).split('/api/')[1];
    calls.push({ method, body: Object.fromEntries(body) });
    if (method === 'conversations.open') return { json: async () => ({ ok: true, channel: { id: CHANNEL } }) };
    if (method === 'chat.postMessage') return { json: async () => ({ ok: true, ts: `${1000 + calls.length}.000100`, channel: body.get('channel') }) };
    if (method === 'chat.delete') return { json: async () => ({ ok: true }) };
    return { json: async () => ({ ok: false, error: 'unhandled_stub_method' }) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function setup(configOverrides = {}) {
  const store = new MemoryStore();
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const credsMap = new Map([[ORG, { org: ORG, mode: 'app', bot_token: 'xoxb-fake' }]]);
  const logs = [];
  const mgr = createKeyRequestManager({
    store, bus, credsMap, log: (m) => logs.push(m),
    config: { approver: APPROVER, approverOrg: ORG, ttlMs: 10 * 60 * 1000, messageTtlMs: 60_000, ...configOverrides },
  });
  return { store, bus, credsMap, logs, mgr };
}

function reply(bus, text, user = APPROVER, channel = CHANNEL, org = ORG) {
  bus.emit('event', { org, channel, ts: String(Date.now() / 1000), user, text,
    thread_ts: null, has_files: false, files_json: null, edited: false, deleted: false, reactions: {}, origin: 'peer' });
}

async function untilNoDelivery(fn, tries = 20) {
  for (let i = 0; i < tries; i++) { const r = await fn(); if (r) return r; await new Promise((res) => setTimeout(res, 5)); }
  return await fn();
}

// ---- happy path: request -> approve -> single-delivery poll -----------------------------------

test('a request is not approved, and carries no key, until the configured approver replies', async () => {
  const { store, bus, mgr, logs } = setup();
  const stub = stubFetch();
  try {
    const created = await mgr.requestKey({ label: 'ci agent', orgs: 'acme', requester: 'test-runner' }, { ip: '1.1.1.1' });
    assert.equal(created.status, 200);
    const { request_id, poll_token, code } = created.body;

    let polled = await mgr.pollRequest(request_id, poll_token);
    assert.equal(polled.body.status, 'pending');
    assert.equal(polled.body.key, undefined);

    reply(bus, `approve ${code}`);
    polled = await untilNoDelivery(async () => { const p = await mgr.pollRequest(request_id, poll_token); return p.body.key ? p : null; });
    assert.equal(polled.body.status, 'approved');
    assert.match(polled.body.key, /^slk_[0-9a-f]{12}_[0-9a-f]{48}$/);

    // The stored request row must never carry the raw key.
    const row = await store.getKeyRequest(request_id);
    assert.equal(JSON.stringify(row).includes(polled.body.key), false);
    assert.equal(row.status, 'approved');
    assert.ok(row.key_id);

    // The DM sent the key exactly once (the intended delivery) — count occurrences across every stubbed call.
    const hits = stub.calls.filter((c) => JSON.stringify(c.body).includes(polled.body.key));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].method, 'chat.postMessage');

    // No log line anywhere in this flow ever contains the key.
    assert.equal(logs.some((l) => l.includes(polled.body.key)), false);
  } finally { stub.restore(); }
});

test('poll_token is single-use: the key is returned once, never again on a later poll', async () => {
  const { bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const { body: { request_id, poll_token, code } } = await mgr.requestKey({ label: 'x', orgs: '*', requester: 'r' }, { ip: '2.2.2.2' });
    reply(bus, `approve ${code}`);
    const first = await untilNoDelivery(async () => { const p = await mgr.pollRequest(request_id, poll_token); return p.body.key ? p : null; });
    assert.ok(first.body.key);
    const second = await mgr.pollRequest(request_id, poll_token);
    assert.equal(second.body.status, 'approved');
    assert.equal(second.body.key, undefined);
  } finally { stub.restore(); }
});

// ---- security requirement 1: no auto-approval, no timeout-approves ----------------------------

test('a request never approves itself — no reply at all means it eventually just expires', async () => {
  const { mgr } = setup({ ttlMs: 20 });
  const stub = stubFetch();
  try {
    const { body: { request_id, poll_token } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '3.3.3.3' });
    await new Promise((r) => setTimeout(r, 60));
    const polled = await mgr.pollRequest(request_id, poll_token);
    assert.equal(polled.body.status, 'expired');
    assert.equal(polled.body.key, undefined);
  } finally { stub.restore(); }
});

// ---- security requirement 2: only the configured approver's replies count ---------------------

test('a reply from someone other than the configured approver is ignored, even with the right code', async () => {
  const { bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const { body: { request_id, poll_token, code } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '4.4.4.4' });
    reply(bus, `approve ${code}`, OTHER_USER);
    await new Promise((r) => setTimeout(r, 30));
    const polled = await mgr.pollRequest(request_id, poll_token);
    assert.equal(polled.body.status, 'pending');
  } finally { stub.restore(); }
});

test('a matching reply in a different channel (not the approver DM) is ignored', async () => {
  const { bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const { body: { request_id, poll_token, code } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '5.5.5.5' });
    reply(bus, `approve ${code}`, APPROVER, 'C_SOME_PUBLIC_CHANNEL');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await mgr.pollRequest(request_id, poll_token)).body.status, 'pending');
  } finally { stub.restore(); }
});

// ---- security requirement 5: expiry blocks late approval ---------------------------------------

test('an approve reply that arrives after expiry does not mint a key', async () => {
  const { store, bus, mgr } = setup({ ttlMs: 20 });
  const stub = stubFetch();
  try {
    const before = (await listKeys(store)).length;
    const { body: { request_id, poll_token, code } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '6.6.6.6' });
    await new Promise((r) => setTimeout(r, 60));   // let it age past ttlMs
    reply(bus, `approve ${code}`);
    await new Promise((r) => setTimeout(r, 30));
    const polled = await mgr.pollRequest(request_id, poll_token);
    assert.equal(polled.body.status, 'expired');
    assert.equal((await listKeys(store)).length, before);
  } finally { stub.restore(); }
});

// ---- security requirement 8: idempotent approve/deny -------------------------------------------

test('replying approve twice mints exactly one key, not two', async () => {
  const { store, bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const before = (await listKeys(store)).length;
    const { body: { code } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '7.7.7.7' });
    reply(bus, `approve ${code}`);
    reply(bus, `approve ${code}`);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await listKeys(store)).length, before + 1);
  } finally { stub.restore(); }
});

test('denying, then approving the same code, is a no-op the second time (deny wins)', async () => {
  const { store, bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const before = (await listKeys(store)).length;
    const { body: { request_id, poll_token, code } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '8.8.8.8' });
    reply(bus, `deny ${code}`);
    await new Promise((r) => setTimeout(r, 30));
    reply(bus, `approve ${code}`);
    await new Promise((r) => setTimeout(r, 30));
    const polled = await mgr.pollRequest(request_id, poll_token);
    assert.equal(polled.body.status, 'denied');
    assert.equal((await listKeys(store)).length, before);
  } finally { stub.restore(); }
});

// ---- validation / config -------------------------------------------------------------------

test('an unconfigured hub (no approver set) refuses every request with a clear 503, never a crash', async () => {
  const { mgr } = setup({ approver: '', approverOrg: '' });
  const r = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '9.9.9.9' });
  assert.equal(r.status, 503);
});

test('a request for an org the hub does not have is rejected before any DM is sent', async () => {
  const { mgr } = setup();
  const stub = stubFetch();
  try {
    const r = await mgr.requestKey({ label: 'x', orgs: 'not-a-real-org' }, { ip: '203.0.113.10' });
    assert.equal(r.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('a missing label is rejected with 400', async () => {
  const { mgr } = setup();
  const r = await mgr.requestKey({ orgs: '*' }, { ip: '11.11.11.11' });
  assert.equal(r.status, 400);
});

// ---- security requirement 3: rate limiting / pending cap ---------------------------------------

test('rate limiting engages after the configured number of requests from one address', async () => {
  const { mgr } = setup({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
  const stub = stubFetch();
  try {
    const ip = '12.12.12.12';
    const a = await mgr.requestKey({ label: 'a', orgs: '*' }, { ip });
    const b = await mgr.requestKey({ label: 'b', orgs: '*' }, { ip });
    const c = await mgr.requestKey({ label: 'c', orgs: '*' }, { ip });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(c.status, 429);
  } finally { stub.restore(); }
});

test('a hub-wide pending cap bounds worst-case DM volume regardless of source address', async () => {
  const { mgr } = setup({ maxPending: 2, rateLimitMax: 100 });
  const stub = stubFetch();
  try {
    const a = await mgr.requestKey({ label: 'a', orgs: '*' }, { ip: '13.13.13.1' });
    const b = await mgr.requestKey({ label: 'b', orgs: '*' }, { ip: '13.13.13.2' });
    const c = await mgr.requestKey({ label: 'c', orgs: '*' }, { ip: '13.13.13.3' });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(c.status, 429);
    assert.equal(stub.calls.filter((x) => x.method === 'chat.postMessage').length, 2);   // never 3
  } finally { stub.restore(); }
});

// ---- poll auth ---------------------------------------------------------------------------------

test('polling with the wrong token is rejected even for a real request id', async () => {
  const { mgr } = setup();
  const stub = stubFetch();
  try {
    const { body: { request_id } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '14.14.14.14' });
    const r = await mgr.pollRequest(request_id, 'totally-wrong-token');
    assert.equal(r.status, 401);
  } finally { stub.restore(); }
});

test('polling an unknown request id is a 404', async () => {
  const { mgr } = setup();
  const r = await mgr.pollRequest('does-not-exist', 'whatever');
  assert.equal(r.status, 404);
});

// ---- irrelevant chatter in the DM must not be mistaken for a decision -------------------------

test('a message from the approver in the DM with no code/keyword is ignored', async () => {
  const { bus, mgr } = setup();
  const stub = stubFetch();
  try {
    const { body: { request_id, poll_token } } = await mgr.requestKey({ label: 'x', orgs: '*' }, { ip: '15.15.15.15' });
    reply(bus, 'hey what is this about?');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await mgr.pollRequest(request_id, poll_token)).body.status, 'pending');
  } finally { stub.restore(); }
});
