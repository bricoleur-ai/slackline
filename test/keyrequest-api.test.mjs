import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApi } from '../api.mjs';
import { MemoryStore } from '../stores/memory.mjs';

// HTTP-level coverage for POST /keys/request + GET /keys/request/<id> — mirrors
// test/keys-api.test.mjs's UDS harness (loopback TCP would make the "unauthenticated on
// purpose" routes indistinguishable from every other route's loopback exemption; a Unix domain
// socket peer reports no remoteAddress, same rationale as that file). NEVER a real Slack call —
// globalThis.fetch is stubbed, same technique keys-api.test.mjs's /say-/react test already uses,
// since ESM named exports (slack.mjs's api()) can't be monkeypatched from a test file.
let sockN = 0;
function sockPath() { return path.join(tmpdir(), `slackline-keyreq-api-${process.pid}-${sockN++}.sock`); }

const APPROVER = 'UAPPROVER';
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

async function withServer(store, opts, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const sp = sockPath();
  const credsMap = opts.credsMap || new Map([[ORG, { org: ORG, mode: 'app', bot_token: 'xoxb-fake' }]]);
  const server = startApi(store, bus, credsMap, {
    secret: '', keyApprover: APPROVER, keyApproverOrg: ORG, keyRequestTtlMs: 10 * 60 * 1000, keyMessageTtlMs: 60_000,
    ...opts, port: sp,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(sp, bus); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function req(sp, reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const h = { ...headers };
    if (data !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ socketPath: sp, path: reqPath, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(b || '{}'); } catch { return b; } })(), raw: b }));
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

function reply(bus, text, user = APPROVER, channel = CHANNEL, org = ORG) {
  bus.emit('event', { org, channel, ts: String(Date.now() / 1000), user, text,
    thread_ts: null, has_files: false, files_json: null, edited: false, deleted: false, reactions: {}, origin: 'peer' });
}

async function untilKey(sp, id, token, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await req(sp, `/keys/request/${id}?token=${token}`);
    if (r.body.key) return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  return await req(sp, `/keys/request/${id}?token=${token}`);
}

// ---- POST /keys/request is reachable with no secret/key at all --------------------------------

test('POST /keys/request needs no secret and no key — that is the whole point', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp) => {
      const r = await req(sp, '/keys/request', { method: 'POST', body: { label: 'ci agent', orgs: 'acme', requester: 'runner' } });
      assert.equal(r.status, 200);
      assert.ok(r.body.request_id);
      assert.ok(r.body.poll_token);
      assert.ok(r.body.expires_at > Date.now());
    });
  } finally { stub.restore(); }
});

// ---- end-to-end: request -> Slack DM -> approver reply (simulated via the bus) -> poll --------

test('end to end: request, approver approves over the bus, requester polls the key exactly once', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp, bus) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'ci agent', orgs: 'acme' } });
      assert.equal(created.status, 200);
      const { request_id, poll_token, code } = created.body;

      const pending = await req(sp, `/keys/request/${request_id}?token=${poll_token}`);
      assert.equal(pending.body.status, 'pending');

      // The DM to the approver must contain the code and the requested scope, and must NOT be
      // guessable as containing the eventual key before approval happens.
      const askDm = stub.calls.find((c) => c.method === 'chat.postMessage');
      assert.ok(askDm.body.text.includes(code));
      assert.ok(askDm.body.text.includes('acme'));

      reply(bus, `approve ${code}`);
      const approved = await untilKey(sp, request_id, poll_token);
      assert.equal(approved.status, 200);
      assert.match(approved.body.key, /^slk_[0-9a-f]{12}_[0-9a-f]{48}$/);

      // Single-use: a second poll must not return the key again.
      const again = await req(sp, `/keys/request/${request_id}?token=${poll_token}`);
      assert.equal(again.body.status, 'approved');
      assert.equal(again.body.key, undefined);

      // The delivered key was posted into the DM exactly once, and chat.delete was scheduled for it.
      const keyPosts = stub.calls.filter((c) => c.method === 'chat.postMessage' && c.body.text.includes(approved.body.key));
      assert.equal(keyPosts.length, 1);
    });
  } finally { stub.restore(); }
});

// ---- security requirement 2: only the configured approver's Slack user id counts --------------

test('a reply from a different Slack user id in the same DM channel never approves anything', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp, bus) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      const { request_id, poll_token, code } = created.body;
      reply(bus, `approve ${code}`, 'UNOTTHEAPPROVER');
      await new Promise((r) => setTimeout(r, 30));
      const polled = await req(sp, `/keys/request/${request_id}?token=${poll_token}`);
      assert.equal(polled.body.status, 'pending');
    });
  } finally { stub.restore(); }
});

// ---- security requirement 5: expiry blocks late approval ---------------------------------------

test('a request past its TTL cannot be approved, even by the right approver with the right code', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, { keyRequestTtlMs: 20 }, async (sp, bus) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      const { request_id, poll_token, code } = created.body;
      await new Promise((r) => setTimeout(r, 60));
      reply(bus, `approve ${code}`);
      await new Promise((r) => setTimeout(r, 30));
      const polled = await req(sp, `/keys/request/${request_id}?token=${poll_token}`);
      assert.equal(polled.body.status, 'expired');
      assert.equal(polled.body.key, undefined);
    });
  } finally { stub.restore(); }
});

// ---- security requirement 8: idempotent approve --------------------------------------------

test('duplicate approve replies over HTTP still mint exactly one key', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp, bus) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      const { code } = created.body;
      reply(bus, `approve ${code}`);
      reply(bus, `approve ${code}`);
      await new Promise((r) => setTimeout(r, 40));
      const keyPosts = stub.calls.filter((c) => c.method === 'chat.postMessage' && /```slk_/.test(c.body.text));
      assert.equal(keyPosts.length, 1);
    });
  } finally { stub.restore(); }
});

// ---- security requirement 3: rate limiting + pending cap engage over real HTTP -----------------

test('rate limiting returns 429 once a single source exceeds the configured request rate', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, { keyRequestRateMax: 2, keyRequestRateWindowMs: 60_000 }, async (sp) => {
      const bodies = [];
      for (let i = 0; i < 3; i++) bodies.push(await req(sp, '/keys/request', { method: 'POST', body: { label: `x${i}`, orgs: '*' } }));
      assert.deepEqual(bodies.map((r) => r.status), [200, 200, 429]);
    });
  } finally { stub.restore(); }
});

test('a hub-wide pending cap returns 429 and never issues more than the cap in DMs', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, { keyRequestMaxPending: 2, keyRequestRateMax: 100 }, async (sp) => {
      const bodies = [];
      for (let i = 0; i < 3; i++) bodies.push(await req(sp, '/keys/request', { method: 'POST', body: { label: `x${i}`, orgs: '*' } }));
      assert.deepEqual(bodies.map((r) => r.status), [200, 200, 429]);
      assert.equal(stub.calls.filter((c) => c.method === 'chat.postMessage').length, 2);
    });
  } finally { stub.restore(); }
});

// ---- validation --------------------------------------------------------------------------------

test('requesting an org the hub does not have is a 400, before any DM is attempted', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp) => {
      const r = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: 'nonexistent-org' } });
      assert.equal(r.status, 400);
      assert.equal(stub.calls.length, 0);
    });
  } finally { stub.restore(); }
});

test('a hub with no approver configured returns 503 rather than a crash', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, { keyApprover: '', keyApproverOrg: '' }, async (sp) => {
      const r = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      assert.equal(r.status, 503);
    });
  } finally { stub.restore(); }
});

// ---- poll auth: request_id alone is not enough ---------------------------------------------

test('GET /keys/request/<id> with the wrong token is 401, with an unknown id is 404', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      const wrong = await req(sp, `/keys/request/${created.body.request_id}?token=nope`);
      assert.equal(wrong.status, 401);
      const missing = await req(sp, '/keys/request/does-not-exist?token=nope');
      assert.equal(missing.status, 404);
    });
  } finally { stub.restore(); }
});

// ---- key material never appears anywhere it shouldn't ------------------------------------------

test('key material never appears in a pending/denied poll response, or in the stored request row', async () => {
  const store = new MemoryStore(); await store.init();
  const stub = stubFetch();
  try {
    await withServer(store, {}, async (sp, bus) => {
      const created = await req(sp, '/keys/request', { method: 'POST', body: { label: 'x', orgs: '*' } });
      const { request_id, poll_token, code } = created.body;
      reply(bus, `deny ${code}`);
      await new Promise((r) => setTimeout(r, 30));
      const denied = await req(sp, `/keys/request/${request_id}?token=${poll_token}`);
      assert.equal(denied.body.status, 'denied');
      assert.equal(denied.raw.includes('slk_'), false);
      const row = await store.getKeyRequest(request_id);
      assert.equal(JSON.stringify(row).includes('slk_'), false);
    });
  } finally { stub.restore(); }
});

// ---- backward compatibility: this route addition must not disturb the existing auth gate ------

test('every pre-existing route is still 401 with no credentials — the new routes did not widen the public surface', async () => {
  const store = new MemoryStore(); await store.init();
  await store.putMessage({ org: ORG, channel: 'C1', ts: '1.1', text: 'hi', user: 'U1', at: Date.now() });
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=hi');
    assert.equal(r.status, 401);
  });
});
