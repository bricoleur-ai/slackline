import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startApi } from '../api.mjs';

// Regression coverage for fix-round-final #2: /tail's mentions=1 filter read
// credsMap.get(org)?.user_id for selfId, but app credentials carry bot_user_id, not user_id.
// With selfId undefined, tailMatch()'s `f.mentions && selfId && ...` predicate short-circuited
// on the falsy selfId and was skipped entirely — an app-mode subscriber asking for mentions=1
// got every message in scope instead of only their @-mentions (a public, documented filter).

function fakeStore() {
  return {
    pendingOutbound: new Map(),
    getUser: async () => null,
    getChannel: async () => null,
  };
}

let nextPort = 18950;
async function withServer(credsMap, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const port = nextPort++;
  const server = startApi(fakeStore(), bus, credsMap, { port, secret: '' });
  await new Promise((resolve) => server.once('listening', resolve));
  // /tail is a long-lived streaming connection with a 25s keepalive tick (api.mjs); a plain
  // server.close() waits for it to end gracefully, so force-close idle sockets instead of
  // hanging this test for 25s per case.
  try { await fn(bus, port); } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

// Opens a /tail request, lets the caller emit bus events, then closes and returns every NDJSON
// line the client received. Node buffers writeHead()'s headers until the first res.write() (no
// flushHeaders() call in api.mjs) — the client's 'response' event won't fire until the first
// matching event is emitted, so don't gate emit() on it; just give the server a tick to reach
// bus.on('event', ...) inside the /tail handler.
function collectTail(port, qs, emit) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/tail?' + qs }, (res) => {
      res.on('data', (c) => buf += c);
    });
    req.on('error', () => {});   // destroy() below triggers a benign socket-hang-up
    setTimeout(async () => {
      try { await emit(); } catch (e) { reject(e); return; }
      setTimeout(() => { req.destroy(); resolve(buf.split('\n').filter(Boolean).map(JSON.parse)); }, 50);
    }, 30);
  });
}

test('/tail mentions=1 filters correctly for app-mode creds (bot_user_id, not user_id)', async () => {
  const credsMap = new Map([['acme', { mode: 'app', org: 'acme', bot_user_id: 'UBOT', bot_id: 'BBOT' }]]);
  await withServer(credsMap, async (bus, port) => {
    const lines = await collectTail(port, 'org=acme&mentions=1', async () => {
      bus.emit('event', { org: 'acme', channel: 'C1', ts: '1.1', text: 'no mention here', user: 'U1' });
      bus.emit('event', { org: 'acme', channel: 'C1', ts: '1.2', text: 'hey <@UBOT> check this', user: 'U1' });
    });
    assert.equal(lines.length, 1, 'only the @-mention should pass the filter');
    assert.equal(lines[0].ts, '1.2');
  });
});

test('/tail mentions=1 still works for user-mode creds (user_id)', async () => {
  const credsMap = new Map([['acme', { mode: 'user', org: 'acme', user_id: 'U9' }]]);
  await withServer(credsMap, async (bus, port) => {
    const lines = await collectTail(port, 'org=acme&mentions=1', async () => {
      bus.emit('event', { org: 'acme', channel: 'C1', ts: '2.1', text: 'no mention here', user: 'U1' });
      bus.emit('event', { org: 'acme', channel: 'C1', ts: '2.2', text: 'hey <@U9> check this', user: 'U1' });
    });
    assert.equal(lines.length, 1, 'only the @-mention should pass the filter');
    assert.equal(lines[0].ts, '2.2');
  });
});
