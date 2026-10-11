// headless delivery mode: spawn `claude -p '<prompt>'` per message, concurrency-capped with a
// FIFO queue. No real processes are spawned — execImpl is injected (same pattern as
// WebSocketImpl in transports/socket.mjs) so concurrency/ordering can be asserted deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpawner, available } from '../bridges/headless.mjs';

// A controllable fake of node:child_process's execFile(file, args, opts, cb): records every
// invocation and lets the test decide exactly when each "process" finishes.
function fakeExec() {
  const calls = [];
  const pending = [];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    pending.push(cb);
  };
  impl.calls = calls;
  impl.finishNext = (err) => { const cb = pending.shift(); cb(err || null); };
  impl.pendingCount = () => pending.length;
  return impl;
}

test('spawns claude -p with the prompt as an argument', async () => {
  const exec = fakeExec();
  const { deliver } = makeSpawner({ execImpl: exec, concurrency: 2 });
  const p = deliver('hello agent');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].file, 'claude');
  assert.deepEqual(exec.calls[0].args, ['-p', 'hello agent']);
  exec.finishNext();
  await p;
});

test('concurrency is capped: a 3rd delivery does not spawn until a slot frees up', async () => {
  const exec = fakeExec();
  const spawner = makeSpawner({ execImpl: exec, concurrency: 2 });

  const p1 = spawner.deliver('one');
  const p2 = spawner.deliver('two');
  const p3 = spawner.deliver('three');

  assert.equal(exec.calls.length, 2, 'only 2 processes spawned at the concurrency cap');
  assert.equal(spawner.active, 2);
  assert.equal(spawner.queued, 1, 'the 3rd delivery is queued, not spawned');

  exec.finishNext();                          // frees a slot -> the queued one should spawn
  await p1;
  assert.equal(exec.calls.length, 3, 'the queued delivery spawns once a slot frees up');
  assert.equal(spawner.queued, 0);

  exec.finishNext();
  exec.finishNext();
  await Promise.all([p2, p3]);
  assert.equal(spawner.active, 0);
});

test('a burst larger than the cap never exceeds it at any point (no unbounded fork)', async () => {
  const exec = fakeExec();
  const cap = 2;
  const spawner = makeSpawner({ execImpl: exec, concurrency: cap });
  const N = 10;
  const promises = Array.from({ length: N }, (_, i) => spawner.deliver(`msg-${i}`));

  assert.ok(exec.calls.length <= cap, `spawned ${exec.calls.length} at once, cap is ${cap}`);

  // Drain the queue, checking the invariant holds at every step.
  while (exec.pendingCount() > 0) {
    assert.ok(spawner.active <= cap);
    exec.finishNext();
  }
  await Promise.all(promises);
  assert.equal(exec.calls.length, N, 'every delivery eventually spawns exactly once');
});

test('a failed spawn rejects only that delivery and still frees the slot for the next one', async () => {
  const exec = fakeExec();
  const { deliver } = makeSpawner({ execImpl: exec, concurrency: 1, log: () => {} });
  const p1 = deliver('boom');
  const p2 = deliver('ok');

  exec.finishNext(new Error('spawn failed'));
  await assert.rejects(p1, /spawn failed/);

  assert.equal(exec.calls.length, 2, 'the next queued delivery spawns even after a failure');
  exec.finishNext();
  await p2;
});

test('available(): true when `which claude` succeeds', async () => {
  const exec = (file, args, cb) => cb(null);
  assert.equal(await available(exec), true);
});

test('available(): false when `which claude` fails (claude not on PATH)', async () => {
  const exec = (file, args, cb) => cb(new Error('not found'));
  assert.equal(await available(exec), false);
});

// A spawned agent acts in its working directory. Getting this wrong hands arbitrary Slack
// input write access to whatever repo the bridge happens to be running from.
test('passes an explicit cwd through to the spawned process', async () => {
  const seen = [];
  const exec = (file, args, opts, cb) => { seen.push(opts); setImmediate(() => cb(null)); };
  const s = makeSpawner({ execImpl: exec, concurrency: 1, cwd: '/tmp/target-project' });
  await s.deliver('hi');
  assert.equal(seen[0].cwd, '/tmp/target-project');
});

test('omits cwd entirely when none is configured, rather than guessing one', async () => {
  const seen = [];
  const exec = (file, args, opts, cb) => { seen.push(opts); setImmediate(() => cb(null)); };
  const s = makeSpawner({ execImpl: exec, concurrency: 1 });
  await s.deliver('hi');
  assert.equal('cwd' in seen[0], false);
});
