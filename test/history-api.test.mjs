// HTTP-level tests for GET /history and /recent's self-heal (api.mjs), over a real server —
// same UDS-harness technique as test/keys-api.test.mjs (loopback is always fully trusted, so a
// plain http.request from this test process can't exercise the auth gate; a Unix socket peer
// reports no remoteAddress and has to present real credentials like a LAN consumer would).
// No real Slack: globalThis.fetch is stubbed per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startApi } from '../api.mjs';
import { MemoryStore } from '../stores/memory.mjs';

let sockN = 0;
function sockPath() { return path.join(tmpdir(), `slackline-history-api-${process.pid}-${sockN++}.sock`); }

async function withServer(store, credsMap, opts, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const sp = sockPath();
  const server = startApi(store, bus, credsMap, { secret: 's3cr3t', ...opts, port: sp });
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(sp, bus); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function req(sp, reqPath, headers = { 'x-slackline-secret': 's3cr3t' }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sp, path: reqPath, method: 'GET', headers }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(b || '{}'); } catch { return b; } })() }));
    });
    r.on('error', reject);
    r.end();
  });
}

function jsonRes(body) { return { status: 200, headers: { get: () => null }, json: async () => body }; }
function withFetch(t, impl) { const real = globalThis.fetch; globalThis.fetch = impl; t.after(() => { globalThis.fetch = real; }); }

function appCreds() { return { mode: 'app', org: 'acme', bot_user_id: 'UBOT', bot_id: 'BBOT', bot_token: 'xoxb-t' }; }

test('GET /history backfills from Slack and returns a transcript, same key-scope gate as /recent', async (t) => {
  const store = new MemoryStore(); await store.init();
  withFetch(t, async (url) => {
    assert.match(String(url), /conversations\.history/);
    return jsonRes({ ok: true, has_more: false, messages: [{ type: 'message', user: 'U1', text: 'older msg', ts: '1.100' }] });
  });
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/history?org=acme&channel=C1');
    assert.equal(r.status, 200);
    assert.match(r.body.transcript, /older msg/);
    assert.equal(r.body.fetched, 1);
    assert.equal(r.body.stored, 1);
  });
});

test('GET /history 403s an out-of-scope org before ever touching Slack', async (t) => {
  const store = new MemoryStore(); await store.init();
  const calls = [];
  withFetch(t, async (url) => { calls.push(url); return jsonRes({ ok: true, messages: [] }); });
  const { createKey } = await import('../keys.mjs');
  const created = await createKey(store, { label: 'scoped', orgs: 'globex' });
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/history?org=acme&channel=C1', { 'x-slackline-key': created.key });
    assert.equal(r.status, 403);
  });
  assert.equal(calls.length, 0);
});

test('GET /history surfaces not_in_channel distinctly, not as an empty-looking result', async (t) => {
  const store = new MemoryStore(); await store.init();
  withFetch(t, async () => jsonRes({ ok: false, error: 'not_in_channel' }));
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/history?org=acme&channel=C1');
    assert.equal(r.status, 200);
    assert.equal(r.body.error, 'not_in_channel');
    assert.equal(r.body.transcript, '');
  });
});

test('GET /recent self-heals: an empty store triggers one backfill page instead of answering empty', async (t) => {
  const store = new MemoryStore(); await store.init();
  let historyCalls = 0;
  // ensureNames also hits users.info for the newly-stored row — only conversations.history calls
  // are the backfill page count this test cares about.
  withFetch(t, async (url) => {
    if (String(url).includes('conversations.history')) historyCalls++;
    return jsonRes({ ok: true, has_more: false, user: { name: 'u1', profile: {} },
      messages: [{ type: 'message', user: 'U1', text: 'was here all along', ts: '1.100' }] });
  });
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/recent?org=acme&channel=C1');
    assert.equal(r.status, 200);
    assert.match(r.body.transcript, /was here all along/);
  });
  assert.equal(historyCalls, 1, 'backfill fetched exactly one page for the self-heal');
});

test('GET /recent self-heal surfaces not_in_channel in the body (still 200, like the rest of this route)', async (t) => {
  const store = new MemoryStore(); await store.init();
  withFetch(t, async () => jsonRes({ ok: false, error: 'not_in_channel' }));
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/recent?org=acme&channel=C1');
    assert.equal(r.status, 200);
    assert.equal(r.body.error, 'not_in_channel');
    assert.equal(r.body.transcript, '');
  });
});

test('GET /recent does not attempt a backfill when the store already has messages for the channel', async (t) => {
  const store = new MemoryStore(); await store.init();
  await store.putMessage({ org: 'acme', channel: 'C1', ts: '1.100', text: 'already have this', user: 'U1', at: Date.now() });
  let historyCalls = 0;
  // ensureNames still hits users.info to resolve U1's name — the assertion below is specifically
  // that conversations.history (the backfill call) is never reached.
  withFetch(t, async (url) => {
    if (String(url).includes('conversations.history')) historyCalls++;
    return jsonRes({ ok: true, messages: [], user: { name: 'u1', profile: {} } });
  });
  await withServer(store, new Map([['acme', appCreds()]]), {}, async (sp) => {
    const r = await req(sp, '/recent?org=acme&channel=C1');
    assert.equal(r.status, 200);
    assert.match(r.body.transcript, /already have this/);
  });
  assert.equal(historyCalls, 0, 'no backfill call when the store already answers the request');
});
