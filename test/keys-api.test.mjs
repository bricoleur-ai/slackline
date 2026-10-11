import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApi } from '../api.mjs';
import { MemoryStore } from '../stores/memory.mjs';
import { createKey, generateKey } from '../keys.mjs';

// api.mjs's loopback exemption (127.0.0.1/::1 -> always fully trusted, see api.mjs's authScope)
// is unchanged by this feature and must stay that way — which means a normal http.request from
// this test process, always arriving over loopback TCP, can never reach the 401/403 paths this
// file exists to prove. Route over a Unix domain socket instead: Node reports
// req.socket.remoteAddress as undefined for a UDS peer (verified against this repo's Node), so
// it isn't in the loopback allowlist and the request has to actually present a secret/key like
// a real remote consumer on the LAN would. startApi's `opts.port` is passed straight to
// server.listen(), which accepts a filesystem path for a UDS exactly like a port number.
let sockN = 0;
function sockPath() { return path.join(tmpdir(), `slackline-keys-api-${process.pid}-${sockN++}.sock`); }

async function withServer(store, opts, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const sp = sockPath();
  const server = startApi(store, bus, opts.credsMap || new Map(), { secret: '', ...opts, port: sp });
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

async function seededStore() {
  const store = new MemoryStore(); await store.init();
  await store.putMessage({ org: 'acme', channel: 'C1', ts: '1.100', text: 'top secret corp message', user: 'U1', at: Date.now() });
  await store.putMessage({ org: 'globex', channel: 'C1', ts: '1.200', text: 'globex side project message', user: 'U1', at: Date.now() });
  return store;
}

// ---- sanity: prove the UDS harness actually defeats loopback trust --------------------------

test('sanity: an unauthenticated request over the UDS harness gets 401 (proves loopback exemption is NOT leaking into these tests)', async () => {
  const store = await seededStore();
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=secret');
    assert.equal(r.status, 401);
  });
});

// ---- unknown / revoked / malformed keys ------------------------------------------------------

test('an unknown key gets 401, not a look inside any org', async () => {
  const store = await seededStore();
  const { key: neverIssued } = generateKey();
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-key': neverIssued } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  });
});

test('a revoked key gets 401', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: '*' });
  await store.revokeKey(created.id);
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-key': created.key } });
    assert.equal(r.status, 401);
  });
});

test('a malformed key (wrong shape entirely) gets 401 rather than a crash', async () => {
  const store = await seededStore();
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/health', { headers: { 'x-slackline-key': 'not-a-real-key' } });
    assert.equal(r.status, 401);
  });
});

// ---- out-of-scope org: 403, never a silent empty result --------------------------------------

test('a key scoped to one org asking for a different org gets 403, not an empty result', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-key': created.key } });
    assert.equal(r.status, 403);
    assert.notEqual(r.body.error, undefined);
    // The critical property: this must NOT look like "searched acme, found nothing" (count:0) —
    // that would silently mask the misconfiguration instead of surfacing it.
    assert.equal(r.body.count, undefined);
  });
});

test('the same key succeeds for the org it IS scoped to', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/query?org=globex&q=globex', { headers: { 'x-slackline-key': created.key } });
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 1);
  });
});

test('a wildcard key reaches every org', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'admin', orgs: '*' });
  await withServer(store, {}, async (sp) => {
    const rAcme = await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-key': created.key } });
    const rGlobex = await req(sp, '/query?org=globex&q=globex', { headers: { 'x-slackline-key': created.key } });
    assert.equal(rAcme.status, 200);
    assert.equal(rAcme.body.count, 1);
    assert.equal(rGlobex.status, 200);
    assert.equal(rGlobex.body.count, 1);
  });
});

// ---- the implicit "sole org" default must not bypass scope -----------------------------------

test('a single-org hub still enforces scope via the implicit sole-org default (no ?org= given)', async () => {
  const store = new MemoryStore(); await store.init();
  await store.putMessage({ org: 'acme-corp', channel: 'C1', ts: '1.100', text: 'corp secret', user: 'U1', at: Date.now() });
  const credsMap = new Map([['acme-corp', { mode: 'app', org: 'acme-corp' }]]);   // credsMap.size===1 -> soleOrg() defaults to it
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });   // scoped to an org the hub doesn't even have
  await withServer(store, { credsMap }, async (sp) => {
    const r = await req(sp, '/query?q=corp', { headers: { 'x-slackline-key': created.key } });   // no ?org= at all
    assert.equal(r.status, 403);
  });
});

// ---- every route in the spec's list is actually scoped ---------------------------------------

test('/recent, /history, /thread, /context, /user, /channel all 403 an out-of-scope org', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  await withServer(store, {}, async (sp) => {
    const headers = { 'x-slackline-key': created.key };
    for (const p of ['/recent?org=acme&channel=C1', '/history?org=acme&channel=C1', '/thread?org=acme&channel=C1&thread_ts=1.100',
                      '/context?org=acme&channel=C1&ts=1.100', '/user?org=acme&id=U1', '/channel?org=acme&id=C1']) {
      const r = await req(sp, p, { headers });
      assert.equal(r.status, 403, `${p} should 403`);
    }
  });
});

test('/file scopes by the org embedded in the archived-attachment path, not a query param', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-blobs-test-'));
  mkdirSync(path.join(dir, 'acme', 'C1', '2026-08-24'), { recursive: true });
  writeFileSync(path.join(dir, 'acme', 'C1', '2026-08-24', 'f1_report.txt'), 'confidential');
  const store = await seededStore();
  const scoped = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  const wildcard = await createKey(store, { label: 'admin', orgs: '*' });
  await withServer(store, { blobRoot: dir }, async (sp) => {
    const denied = await req(sp, '/file?rel=acme/C1/2026-08-24/f1_report.txt', { headers: { 'x-slackline-key': scoped.key } });
    assert.equal(denied.status, 403);
    const allowed = await req(sp, '/file?rel=acme/C1/2026-08-24/f1_report.txt', { headers: { 'x-slackline-key': wildcard.key } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.raw, 'confidential');
  });
});

test('/say and /react reject an out-of-scope org before ever touching Slack', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  const credsMap = new Map([['acme', { mode: 'app', org: 'acme', bot_token: 'xoxb-B' }]]);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls.push(a); return { json: async () => ({ ok: true }) }; };
  try {
    await withServer(store, { credsMap }, async (sp) => {
      const headers = { 'x-slackline-key': created.key };
      const say = await req(sp, '/say', { method: 'POST', headers, body: { org: 'acme', channel: 'C1', text: 'hi' } });
      assert.equal(say.status, 403);
      const react = await req(sp, '/react', { method: 'POST', headers, body: { org: 'acme', channel: 'C1', ts: '1.1', emoji: 'x' } });
      assert.equal(react.status, 403);
    });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 0, 'a forbidden org must never reach the Slack API call');
});

test('/tail rejects an explicit out-of-scope org up front (before opening the stream)', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  await withServer(store, {}, async (sp) => {
    const r = await req(sp, '/tail?org=acme', { headers: { 'x-slackline-key': created.key } });
    assert.equal(r.status, 403);
  });
});

test('/tail with no ?org= (multi-org hub) still filters live events to the key\'s scope', async () => {
  const store = new MemoryStore(); await store.init();
  const credsMap = new Map([['acme', { mode: 'app', org: 'acme' }], ['globex', { mode: 'app', org: 'globex' }]]);
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  await withServer(store, { credsMap }, async (sp, bus) => {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const r = http.request({ socketPath: sp, path: '/tail', method: 'GET', headers: { 'x-slackline-key': created.key } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => chunks.push(c.toString()));
        setTimeout(() => { r.destroy(); resolve(); }, 250);
      });
      r.on('error', () => {});   // destroy() triggers a benign socket-hang-up error; ignore it
      r.end();
      setTimeout(() => {
        bus.emit('event', { org: 'acme', channel: 'C1', ts: '2.1', text: 'out-of-scope-corp-secret', user: 'U1',
          thread_ts: null, has_files: false, files_json: null, edited: false, deleted: false, reactions: {}, origin: 'peer' });
        bus.emit('event', { org: 'globex', channel: 'C1', ts: '2.2', text: 'in-scope-globex-update', user: 'U1',
          thread_ts: null, has_files: false, files_json: null, edited: false, deleted: false, reactions: {}, origin: 'peer' });
      }, 50);
    });
    const body = chunks.join('');
    assert.ok(body.includes('in-scope-globex-update'), 'the in-scope org event should stream through');
    assert.ok(!body.includes('out-of-scope-corp-secret'), 'the out-of-scope org event must NOT stream through');
  });
});

// ---- backward compatibility: SLACKLINE_SECRET is still a master credential -------------------

test('SLACKLINE_SECRET still grants every org, over a non-loopback connection', async () => {
  const store = await seededStore();
  await withServer(store, { secret: 'S3cr3t' }, async (sp) => {
    const headers = { 'x-slackline-secret': 'S3cr3t' };
    const rAcme = await req(sp, '/query?org=acme&q=secret', { headers });
    const rGlobex = await req(sp, '/query?org=globex&q=globex', { headers });
    assert.equal(rAcme.status, 200);
    assert.equal(rAcme.body.count, 1);
    assert.equal(rGlobex.status, 200);
    assert.equal(rGlobex.body.count, 1);
  });
});

test('a wrong secret still gets 401 (not confused with a key)', async () => {
  const store = await seededStore();
  await withServer(store, { secret: 'S3cr3t' }, async (sp) => {
    const r = await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-secret': 'wrong' } });
    assert.equal(r.status, 401);
  });
});

// ---- last_used bookkeeping ---------------------------------------------------------------------

test('a successful key-authenticated request stamps last_used', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: '*' });
  assert.equal((await store.getKey(created.id)).last_used, null);
  await withServer(store, {}, async (sp) => {
    await req(sp, '/health', { headers: { 'x-slackline-key': created.key } });
  });
  assert.ok(typeof (await store.getKey(created.id)).last_used === 'number');
});

// ---- key material must never appear in any output ---------------------------------------------

test('key material never appears in any response body, success or failure', async () => {
  const store = await seededStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  const secretHalf = created.key.split('_')[2];
  await withServer(store, {}, async (sp) => {
    const headers = { 'x-slackline-key': created.key };
    const bodies = [
      (await req(sp, '/health', { headers })).raw,
      (await req(sp, '/query?org=globex&q=globex', { headers })).raw,
      (await req(sp, '/query?org=acme&q=secret', { headers })).raw,       // the 403 path
      (await req(sp, '/query?org=acme&q=secret', { headers: { 'x-slackline-key': 'slk_' + 'a'.repeat(12) + '_' + 'b'.repeat(48) } })).raw, // the 401 path
    ];
    for (const b of bodies) {
      assert.equal(b.includes(created.key), false);
      assert.equal(b.includes(secretHalf), false);
    }
  });
});
