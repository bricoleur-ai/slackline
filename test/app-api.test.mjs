import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startApi } from '../api.mjs';

// POST /apps — lets a running Mode 2/3 host be handed a Slack app credential without a
// restart. Same shape/auth/logging discipline as the existing POST /tokens
// tested in test/api-say-badge.test.mjs; this file covers the new route only.

function fakeStore() {
  const apps = new Map();
  return {
    pendingOutbound: new Map(), putOutbound: async () => {},
    putApp: async (a) => { apps.set(a.org, { ...a }); },
    getApp: async (org) => apps.get(org) || null,
    listApps: async () => [...apps.values()],
    _apps: apps,
  };
}

// Stubs global fetch for the auth.test round-trip verifyAndPersist makes.
function stubFetch(reply) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { json: async () => reply }; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let nextPort = 18980;   // own range — 18901+ is api-say-badge.test.mjs, 18950+ is api-tail-mentions.test.mjs
async function withServer(store, opts, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const port = nextPort++;
  const server = startApi(store, bus, new Map(), { port, secret: '', ...opts });
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.on('error', reject);
    req.end(data);
  });
}

test('POST /apps persists a verified app credential via putApp', async () => {
  const store = fakeStore();
  const { restore } = stubFetch({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'Acme', team_id: 'T1' });
  try {
    await withServer(store, {}, async (port) => {
      const r = await post(port, '/apps', { org: 'acme', app_token: 'xapp-A', bot_token: 'xoxb-B' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.bot_user_id, 'UBOT');
    });
    // org was explicitly given ('acme') so ensureBotIdentity's envSourced rename (only triggers
    // when org is left at 'default') does not apply — the explicit org is honored verbatim.
    const row = await store.getApp('acme');
    assert.equal(row.bot_token, 'xoxb-B');
  } finally { restore(); }
});

test('POST /apps response never includes token values', async () => {
  const store = fakeStore();
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  try {
    await withServer(store, {}, async (port) => {
      const r = await post(port, '/apps', { org: 'acme', app_token: 'xapp-SECRET', bot_token: 'xoxb-SECRET' });
      const dump = JSON.stringify(r.body);
      assert.equal(dump.includes('xapp-SECRET'), false);
      assert.equal(dump.includes('xoxb-SECRET'), false);
    });
  } finally { restore(); }
});

test('POST /apps returns 400 without crashing when a token is missing', async () => {
  const store = fakeStore();
  await withServer(store, {}, async (port) => {
    const r = await post(port, '/apps', { org: 'acme', app_token: 'xapp-A' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /app_token and bot_token/);
  });
  assert.equal((await store.listApps()).length, 0);
});

test('POST /apps returns 400 and does not persist when auth.test fails (never stores a half-built credential)', async () => {
  const store = fakeStore();
  const { restore } = stubFetch({ ok: false, error: 'invalid_auth' });
  try {
    await withServer(store, {}, async (port) => {
      const r = await post(port, '/apps', { org: 'acme', app_token: 'xapp-A', bot_token: 'xoxb-BAD' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /could not verify bot identity/);
    });
    assert.equal((await store.listApps()).length, 0);
  } finally { restore(); }
});

test('POST /apps calls the optional onApp hook with the verified (persisted) credential', async () => {
  const store = fakeStore();
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  let seen = null;
  try {
    await withServer(store, { onApp: (c) => { seen = c; } }, async (port) => {
      await post(port, '/apps', { org: 'acme', app_token: 'xapp-A', bot_token: 'xoxb-B' });
    });
    assert.ok(seen);
    assert.equal(seen.bot_id, 'B1');
  } finally { restore(); }
});

test('POST /apps works fine when onApp is not provided (default no-op — existing hosts do not have to opt in)', async () => {
  const store = fakeStore();
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  try {
    await withServer(store, {}, async (port) => {
      const r = await post(port, '/apps', { org: 'acme', app_token: 'xapp-A', bot_token: 'xoxb-B' });
      assert.equal(r.status, 200);
    });
  } finally { restore(); }
});

// A real HTTP request in this test suite always arrives from 127.0.0.1, which authScope()
// exempts from the secret/key check by design (loopback is trusted) — so a live request can't
// distinguish "gated and I'm exempt" from "not gated at all". Assert the structural property
// instead: /apps must be defined after the auth gate's early-return in api.mjs's source, the
// same gate /tokens sits behind, so a future edit can't accidentally move it before that check.
// (The gate itself became authScope()/`scope === null` when scoped keys were added — see
// keys.mjs and api.mjs's authScope — but the property this test guards is unchanged.)
test('POST /apps sits behind the same auth gate as the other data routes', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api.mjs', import.meta.url), 'utf8');
  const authedIdx = src.indexOf('if (scope === null) return json(res, 401');
  const tokensIdx = src.indexOf("p === '/tokens'");
  const appsIdx = src.indexOf("p === '/apps'");
  assert.ok(authedIdx > 0 && tokensIdx > authedIdx, 'sanity: /tokens is where we expect it, after the auth gate');
  assert.ok(appsIdx > authedIdx, '/apps must be declared after the auth gate');
});
