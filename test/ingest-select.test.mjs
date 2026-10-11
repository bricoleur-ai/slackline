import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startOrg, pickTransport } from '../ingest.mjs';

test('app creds select the socket transport', () => {
  assert.equal(pickTransport({ mode: 'app' }).name, 'socket');
});

test('user creds select the rtm transport', () => {
  assert.equal(pickTransport({ mode: 'user' }).name, 'rtm');
});

test('creds with no mode default to rtm for backward compatibility', () => {
  assert.equal(pickTransport({ token: 'x', cookie: 'y' }).name, 'rtm');
});

// Pins the reconnect/backoff policy that ingest.mjs owns (transports only supply
// events). Regression target: the brief's open() reset `backoff = 1000` right after
// calling connect() (an ATTEMPT), not on a successful open, which made the delay
// oscillate at 2000ms forever instead of growing exponentially. The fix resets
// backoff only from the transport's onOpen callback (fired on SUCCESS).
//
// Uses a fake transport injected via opts.transport (test-only hook, mirrors the
// WebSocketImpl override pattern already used in transports/socket.mjs) and mocks
// global setTimeout so no real backoff interval is ever waited out.
test('reconnect backoff grows on repeated failures and resets after a successful open', (t) => {
  const delays = [];
  const pending = [];
  t.mock.method(global, 'setTimeout', (fn, ms) => { delays.push(ms); pending.push(fn); return 0; });

  let onCloseRef, onOpenRef, connectCount = 0;
  const fakeTransport = {
    name: 'fake',
    connect({ onClose, onOpen }) {
      connectCount++;
      onCloseRef = onClose;
      onOpenRef = onOpen;
      return { close() {} };
    },
  };

  const store = {};
  const creds = { org: 'test', mode: 'user' };
  const runner = startOrg(store, creds, { transport: fakeTransport, log: () => {} });

  assert.equal(connectCount, 1, 'startOrg opens immediately');

  // Attempt 1 fails (non-fatal) -> backoff doubles from the initial 1000 to 2000.
  onCloseRef(new Error('boom'), false);
  assert.equal(delays[0], 2000);

  // Retry (attempt 2) also fails, WITHOUT any onOpen in between -> must keep
  // doubling from 2000, not reset back down because a new attempt started.
  pending.shift()();
  assert.equal(connectCount, 2);
  onCloseRef(new Error('boom2'), false);
  assert.equal(delays[1], 4000, 'backoff must keep growing across attempts, not reset on each connect() call');

  // Attempt 3 also fails -> keeps growing.
  pending.shift()();
  onCloseRef(new Error('boom3'), false);
  assert.equal(delays[2], 8000);

  // Attempt 4 succeeds (onOpen fires) -> backoff resets to the floor.
  pending.shift()();
  assert.equal(connectCount, 4);
  onOpenRef();
  onCloseRef(new Error('boom4'), false);
  assert.equal(delays[3], 2000, 'a successful open must reset backoff to the 1000ms floor before the next doubling');

  runner.stop();
});
