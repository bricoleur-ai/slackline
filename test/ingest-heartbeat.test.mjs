// Heartbeat: the periodic liveness line startOrg() emits so an idle-but-wedged Socket Mode
// connection cannot look identical to a healthy one in the log. This is what would have caught
// the Aug 2026 incident — a connection that logged "socket mode open" and then nothing for ~2
// days while scripts/healthcheck.mjs kept reporting it healthy off that same stale line.
//
// Uses the same fake-transport injection (opts.transport) as test/ingest-select.test.mjs, plus
// node:test's built-in fake timers so setInterval/setTimeout/Date are all driven by tick()
// rather than real wall-clock time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startOrg } from '../ingest.mjs';

function makeFakeTransport() {
  const state = { connectCount: 0, onOpen: null, onEvent: null, onClose: null, closed: [] };
  const transport = {
    name: 'fake',
    connect({ onOpen, onEvent, onClose }) {
      state.connectCount++;
      state.onOpen = onOpen;
      state.onEvent = onEvent;
      state.onClose = onClose;
      return { close: () => state.closed.push(state.connectCount) };
    },
  };
  return { transport, state };
}

test('heartbeat emits on an idle connection, carrying connected state and idle seconds', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 60_000 });

  state.onOpen();                 // transport reports connected, no events yet
  t.mock.timers.tick(60_000);
  assert.equal(logs.filter(l => l.includes('heartbeat')).length, 1);
  assert.match(logs.at(-1), /^\[acme\] heartbeat connected=true idleSec=60$/);

  runner.stop();
});

test('idle seconds keeps rising across repeated heartbeats when nothing arrives', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 30_000 });

  state.onOpen();
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(30_000);
  const beats = logs.filter(l => l.includes('heartbeat'));
  assert.deepEqual(beats.map(l => l.match(/idleSec=(\d+)/)[1]), ['30', '60', '90']);

  runner.stop();
});

test('a received event resets idle time for the next heartbeat', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 10_000 });

  state.onOpen();
  t.mock.timers.tick(7_000);
  state.onEvent({ type: 'test_ping' });   // a no-op event type: normalize() drops it, but onEvent still saw it
  t.mock.timers.tick(3_000);              // completes the 10s interval: 3s since the event, not 10s since open
  assert.match(logs.at(-1), /idleSec=3$/);

  runner.stop();
});

test('SLACKLINE_HEARTBEAT_MS=0 disables the timer entirely', (t) => {
  const calls = [];
  t.mock.method(global, 'setInterval', (fn, ms) => { calls.push(ms); return { unref() {} }; });
  const { transport } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: () => {}, heartbeatMs: 0 });

  assert.equal(calls.length, 0, 'heartbeatMs=0 must never call setInterval');
  runner.stop();
});

test('heartbeat interval defaults to 5 minutes absent opts/env override', (t) => {
  delete process.env.SLACKLINE_HEARTBEAT_MS;
  const calls = [];
  t.mock.method(global, 'setInterval', (fn, ms) => { calls.push(ms); return { unref() {} }; });
  const { transport } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' }, { transport, log: () => {} });

  assert.deepEqual(calls, [5 * 60 * 1000]);
  runner.stop();
});

test('stop() clears the heartbeat timer — no further lines after stop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 1_000 });

  state.onOpen();
  t.mock.timers.tick(1_000);
  const countAtStop = logs.length;
  runner.stop();
  t.mock.timers.tick(10_000);
  assert.equal(logs.length, countAtStop, 'no heartbeat lines after stop()');
});

// --- Opt-in idle-reconnect (SLACKLINE_IDLE_RECONNECT_MS / opts.idleReconnectMs) ---

test('idle-reconnect is off by default: no reconnect no matter how idle', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: () => {}, heartbeatMs: 1_000 });   // idleReconnectMs not set -> default off

  state.onOpen();
  t.mock.timers.tick(100_000);   // stay connected and silent for a long time
  assert.equal(state.connectCount, 1, 'must never force a reconnect when the feature is off');

  runner.stop();
});

test('idle-reconnect, once enabled, forces a reconnect after the threshold while connected', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 1_000, idleReconnectMs: 5_000 });

  state.onOpen();
  t.mock.timers.tick(4_000);
  assert.equal(state.connectCount, 1, 'not yet at the threshold');
  t.mock.timers.tick(1_000);     // 5s idle while connected -> forces a reconnect
  assert.equal(state.connectCount, 2, 'reconnect forced once idle >= SLACKLINE_IDLE_RECONNECT_MS');
  assert.ok(logs.some(l => l.includes('forcing reconnect')));

  runner.stop();
});

test('idle-reconnect never fires once a close was fatal — it does not fight fatal semantics', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 1_000, idleReconnectMs: 2_000 });

  state.onOpen();
  t.mock.timers.tick(500);
  state.onClose(new Error('socket mode disabled for this app (link_disabled)'), true);   // fatal
  assert.ok(logs.some(l => l.includes('fatal — not reconnecting')));

  t.mock.timers.tick(60_000);   // idle keeps climbing well past the threshold
  assert.equal(state.connectCount, 1, 'a fatal close must never be second-guessed by idle-reconnect');

  runner.stop();
});

test('idle-reconnect does not fight the backoff loop: a forced reconnect leaves backoff untouched', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const logs = [];
  const { transport, state } = makeFakeTransport();
  const runner = startOrg({}, { org: 'acme', mode: 'user' },
    { transport, log: (m) => logs.push(m), heartbeatMs: 1_000, idleReconnectMs: 5_000 });

  state.onOpen();                     // backoff is at its 1000ms floor, never having failed yet
  t.mock.timers.tick(5_000);          // idle-reconnect fires -> connectCount 2, backoff untouched
  assert.equal(state.connectCount, 2);

  // The forced reconnect's attempt now fails (non-fatal). If the forced reconnect had reset or
  // corrupted backoff bookkeeping, the resulting delay would not be exactly one doubling (2000ms)
  // from the pre-forced-reconnect floor of 1000ms.
  state.onClose(new Error('boom'), false);
  t.mock.timers.tick(1_999);
  assert.equal(state.connectCount, 2, 'must not reconnect before the doubled 2000ms backoff elapses');
  t.mock.timers.tick(1);
  assert.equal(state.connectCount, 3, 'reconnects at exactly the normal doubled backoff, proving idle-reconnect never touched it');

  runner.stop();
});
