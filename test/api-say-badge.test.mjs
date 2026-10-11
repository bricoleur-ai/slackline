import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startApi } from '../api.mjs';

// Regression coverage for fix-round-1 item #1: api.mjs's HTTP /say route had its own
// hardcoded badge logic that ignored creds.mode, so an app-mode bot posting through
// standalone.mjs/ingestd.mjs (the only outbound-posting surface for those hosts) got
// badged even though it has its own distinct Slack identity. /say must defer to the
// same badgeFor() used by mcp.mjs's slack_say, in both directions.

function fakeStore() { return { pendingOutbound: new Map(), putOutbound: async () => {} }; }

// Captures the outbound chat.postMessage call api.mjs's /say route makes via slack.mjs's
// api(), same technique test/api-shape.test.mjs uses to inspect what slack.mjs itself sends.
function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ ok: true, ts: '123.456', channel: 'C1' }) }; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// api.mjs does `opts.port || 8790`, so port:0 (the usual "give me any free port" idiom)
// falls back to the real default instead of an ephemeral one — give each test its own
// fixed port instead.
let nextPort = 18901;
async function withServer(credsMap, fn) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const port = nextPort++;
  const server = startApi(fakeStore(), bus, credsMap, { port, secret: '' });
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function postSay(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/say', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.on('error', reject);
    req.end(data);
  });
}

function textParam(body) { return new URLSearchParams(body).get('text'); }

test('/say does not badge an app-mode post', async () => {
  const credsMap = new Map([['acme', { mode: 'app', org: 'acme', bot_token: 'xoxb-B', app_token: 'xapp-A' }]]);
  const { calls, restore } = stubFetch();
  try {
    await withServer(credsMap, async (port) => {
      const r = await postSay(port, { org: 'acme', channel: 'C1', text: 'hello' });
      assert.equal(r.status, 200);
    });
    assert.equal(textParam(calls[0].init.body), 'hello');
  } finally { restore(); }
});

test('/say badges a user-mode post', async () => {
  const credsMap = new Map([['acme', { mode: 'user', org: 'acme', token: 'xoxc-U', cookie: 'C' }]]);
  const { calls, restore } = stubFetch();
  try {
    await withServer(credsMap, async (port) => {
      const r = await postSay(port, { org: 'acme', channel: 'C1', text: 'hello' });
      assert.equal(r.status, 200);
    });
    assert.equal(textParam(calls[0].init.body), ':robot_face: hello');
  } finally { restore(); }
});

test('/say honors no_badge in user mode', async () => {
  const credsMap = new Map([['acme', { mode: 'user', org: 'acme', token: 'xoxc-U', cookie: 'C' }]]);
  const { calls, restore } = stubFetch();
  try {
    await withServer(credsMap, async (port) => {
      await postSay(port, { org: 'acme', channel: 'C1', text: 'hello', no_badge: true });
    });
    assert.equal(textParam(calls[0].init.body), 'hello');
  } finally { restore(); }
});

test('/say returns 400 for an unknown org without crashing (creds lookup miss)', async () => {
  const credsMap = new Map();
  const { restore } = stubFetch();
  try {
    await withServer(credsMap, async (port) => {
      const r = await postSay(port, { org: 'nope', channel: 'C1', text: 'hello' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'unknown org');
    });
  } finally { restore(); }
});
