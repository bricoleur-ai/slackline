import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnvelopeHandler, connect } from '../transports/socket.mjs';
import { EventEmitter } from 'node:events';

function harness() {
  const sent = [], events = [], closes = [];
  const h = makeEnvelopeHandler({
    send: (m) => sent.push(m),
    onEvent: (e) => events.push(e),
    onClose: (err, fatal) => closes.push({ err, fatal }),
    log: () => {},
  });
  return { h, sent, events, closes };
}

test('every envelope is acked', () => {
  const { h, sent } = harness();
  h({ envelope_id: 'E1', type: 'events_api', payload: { event_id: 'Ev1', event: { type: 'message', ts: '1.1' } } });
  assert.deepEqual(JSON.parse(sent[0]), { envelope_id: 'E1' });
});

test('ack is sent BEFORE the event is dispatched for processing', () => {
  const order = [];
  const h = makeEnvelopeHandler({
    send: () => order.push('ack'), onEvent: () => order.push('process'),
    onClose: () => {}, log: () => {},
  });
  h({ envelope_id: 'E1', type: 'events_api', payload: { event_id: 'Ev1', event: { type: 'message' } } });
  assert.deepEqual(order, ['ack', 'process'], 'processing can outlast the ack window');
});

test('duplicate event_id is acked but processed only once', () => {
  const { h, sent, events } = harness();
  const env = { envelope_id: 'E1', type: 'events_api', payload: { event_id: 'Ev1', event: { type: 'message' } } };
  h(env);
  h({ ...env, envelope_id: 'E2' });          // Slack redelivery
  assert.equal(sent.length, 2, 'both redeliveries must be acked');
  assert.equal(events.length, 1, 'but only processed once');
});

test('link_disabled is fatal and must not trigger a reconnect', () => {
  const { h, closes } = harness();
  h({ type: 'disconnect', reason: 'link_disabled' });
  assert.equal(closes[0].fatal, true);
});

test('refresh_requested is a normal, non-fatal reconnect', () => {
  const { h, closes } = harness();
  h({ type: 'disconnect', reason: 'refresh_requested' });
  assert.equal(closes[0].fatal, false);
});

test('hello is consumed without being dispatched as an event', () => {
  const { h, events } = harness();
  h({ type: 'hello', connection_info: { app_id: 'A1' }, debug_info: { approximate_connection_time: 18060 } });
  assert.equal(events.length, 0);
});

test('non-event envelope types are acked and ignored', () => {
  const { h, sent, events } = harness();
  h({ envelope_id: 'E9', type: 'slash_commands', payload: { command: '/x' } });
  assert.equal(sent.length, 1, 'must still ack or Slack retries');
  assert.equal(events.length, 0);
});

test('a null/non-object frame does not crash the handler', () => {
  const { h, sent, events, closes } = harness();
  assert.doesNotThrow(() => h(null));
  assert.doesNotThrow(() => h('not-an-object'));
  assert.equal(sent.length, 0);
  assert.equal(events.length, 0);
  assert.equal(closes.length, 0);
});

// Regression: Slack closes the underlying socket shortly after ANY disconnect
// envelope (including link_disabled). Without dedup, that produces a SECOND
// onClose(null, false) that would overwrite the fatal:true signal and cause
// the (not-yet-written) reconnect layer to retry a human-only-fixable condition.
test('connect(): a disconnect envelope followed by the socket closing fires onClose exactly once, fatal preserved', async () => {
  const realFetch = globalThis.fetch;
  let fakeSocket;
  class FakeWebSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; fakeSocket = this; }
    send() {}
    close() {}
  }
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: 'wss://example.test/socket' }) });
  const closes = [];
  const handle = connect({
    creds: { org: 'test-org', app_token: 'xapp-APP' },
    onEvent: () => {},
    onClose: (err, fatal) => closes.push({ err, fatal }),
    log: () => {},
    WebSocketImpl: FakeWebSocket,
  });
  globalThis.fetch = realFetch;             // the mocked fetch already ran synchronously above

  // Let the connect() async IIFE (fetch -> .then(json) -> `new WebSocketImpl`) settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fakeSocket, 'fake WebSocket should have been constructed');

  fakeSocket.emit('message', Buffer.from(JSON.stringify({ type: 'disconnect', reason: 'link_disabled' })));
  fakeSocket.emit('close');                 // Slack's server-side close that follows the envelope
  handle.close();

  assert.equal(closes.length, 1, 'onClose must fire exactly once for one disconnect');
  assert.equal(closes[0].fatal, true, 'the fatal signal from link_disabled must not be overwritten');
});

// Regression: no existing test fired a fake 'open' event, so accidentally dropping
// `onOpen && onOpen()` from connect() would go uncaught — ingest.mjs's reconnect backoff only
// resets on onOpen, so a silent drop here would make backoff grow monotonically to the 30s cap
// instead of resetting after a successful reconnect.
test('connect(): a socket "open" event fires onOpen', async () => {
  const realFetch = globalThis.fetch;
  let fakeSocket, opened = false;
  class FakeWebSocket extends EventEmitter {
    constructor(url) { super(); this.url = url; fakeSocket = this; }
    send() {}
    close() {}
  }
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: 'wss://example.test/socket' }) });
  const handle = connect({
    creds: { org: 'test-org', app_token: 'xapp-APP' },
    onEvent: () => {},
    onClose: () => {},
    onOpen: () => { opened = true; },
    log: () => {},
    WebSocketImpl: FakeWebSocket,
  });
  globalThis.fetch = realFetch;

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fakeSocket, 'fake WebSocket should have been constructed');

  fakeSocket.emit('open');
  assert.equal(opened, true, 'onOpen must fire on a real socket open event');
  handle.close();
});
