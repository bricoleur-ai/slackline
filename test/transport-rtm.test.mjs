import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect } from '../transports/rtm.mjs';

test('a failed rtm.connect reports a non-fatal close so ingest can retry', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'invalid_auth' }) });
  const closed = await new Promise((resolve) => {
    connect({ creds: { mode: 'user', token: 't', cookie: 'c', org: 'o' },
      onEvent: () => {}, onClose: (err, fatal) => resolve({ err, fatal }), log: () => {} });
  });
  assert.match(closed.err.message, /invalid_auth/);
  assert.notEqual(closed.fatal, true, 'auth failures are retryable at the ingest layer');
});

// Regression: neither transport test fired a fake 'open' event, so accidentally dropping
// `onOpen && onOpen()` from either transport would go uncaught — ingest.mjs's reconnect backoff
// only resets on onOpen, so a silent drop here would make backoff grow monotonically to the 30s
// cap instead of resetting after a successful reconnect.
test('connect(): a socket "open" event fires onOpen', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: 'wss://example.test/rtm' }) });
  let fakeSocket, opened = false;
  class FakeWebSocket extends EventEmitter {
    constructor(url, opts) { super(); this.url = url; this.opts = opts; fakeSocket = this; }
    close() {}
  }
  const handle = connect({
    creds: { mode: 'user', token: 't', cookie: 'c', org: 'o' },
    onEvent: () => {},
    onClose: () => {},
    onOpen: () => { opened = true; },
    log: () => {},
    WebSocketImpl: FakeWebSocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fakeSocket, 'fake WebSocket should have been constructed');
  fakeSocket.emit('open');
  assert.equal(opened, true, 'onOpen must fire on a real socket open event');
  handle.close();
});
