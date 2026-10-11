// agents/listen.mjs is the process that sits beside one Codex or Muse session and hands it
// Slack messages. What matters: messages arrive in order, one bad delivery does not end the
// listener, a vanished session or agent process does, and the log never carries a message body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, parseArgs, createListener, main } from '../agents/listen.mjs';
import { SessionGone, clearInbox } from '../agents/deliver.mjs';

// A stand-in for openStreams: hands the test the onRow callback and records stop().
function fakeOpen() {
  const h = { onRow: null, stopped: false };
  return { h, open: ({ onRow }) => { h.onRow = onRow; return { ready: Promise.resolve(), stop() { h.stopped = true; } }; } };
}
const row = (ts, text = 'secret body text') => ({ channel: 'C1', ts, text, origin: 'human' });
const base = { cfg: { url: 'http://hub' }, streams: [{ org: 'acme', channels: ['C1'] }] };

test('parseArgs reads every flag and turns the watched pid into a number', () => {
  assert.deepEqual(parseArgs(['--agent', 'codex', '--session', 'T-1', '--dir', '/p', '--watch-pid', '4242', '--deliver', 'tmux', '--tmux-pane', '%3']),
    { agent: 'codex', session: 'T-1', dir: '/p', watchPid: 4242, deliver: 'tmux', tmuxPane: '%3' });
  assert.deepEqual(parseArgs(['--agent', 'muse']), { agent: 'muse' });
});

test('alive() is true for this process and false for a pid that cannot exist', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(2 ** 22 + 12345), false);
});

test('delivers messages one at a time, in arrival order, even when delivery is slow', async () => {
  const { h, open } = fakeOpen();
  const order = [];
  const deliver = async (r, org) => { order.push(`start ${r.ts}`); await new Promise(res => setTimeout(res, r.ts === '1.1' ? 30 : 0)); order.push(`end ${r.ts} ${org}`); };
  const l = createListener({ ...base, deliver, open });
  h.onRow(row('1.1'), 'acme'); h.onRow(row('2.2'), 'acme');
  await l.idle();
  assert.deepEqual(order, ['start 1.1', 'end 1.1 acme', 'start 2.2', 'end 2.2 acme']);
  l.stop('test over');
});

test('a failed delivery is logged and the listener carries on; the log never contains the message body', async () => {
  const { h, open } = fakeOpen();
  const logs = []; const delivered = [];
  const deliver = async (r) => { if (r.ts === '1.1') throw new Error('codex queue: daemon busy'); delivered.push(r.ts); };
  const l = createListener({ ...base, deliver, open, log: (m) => logs.push(m) });
  h.onRow(row('1.1'), 'acme'); h.onRow(row('2.2'), 'acme');
  await l.idle();
  assert.deepEqual(delivered, ['2.2']);
  assert.equal(l.stopped, false);
  assert.ok(logs.some(m => /delivery failed acme\/C1\/1\.1: codex queue: daemon busy/.test(m)));
  assert.ok(logs.some(m => /delivered acme\/C1\/2\.2/.test(m)));
  assert.ok(logs.every(m => !m.includes('secret body text')));
  l.stop('test over');
});

test('a vanished session stops the listener and its streams, and skips what was queued behind it', async () => {
  const { h, open } = fakeOpen();
  const exits = []; const attempted = [];
  const deliver = async (r) => { attempted.push(r.ts); throw new SessionGone('codex queue: thread not found'); };
  const l = createListener({ ...base, deliver, open, onExit: (why) => exits.push(why) });
  h.onRow(row('1.1'), 'acme'); h.onRow(row('2.2'), 'acme');
  await l.idle();
  assert.deepEqual(attempted, ['1.1']);
  assert.equal(l.stopped, true);
  assert.equal(h.stopped, true);
  assert.deepEqual(exits, ['session is gone']);
});

test('a message that arrives after the agent exited, before the poll noticed, is not delivered', async () => {
  const { h, open } = fakeOpen();
  const exits = [], delivered = [];
  const l = createListener({ ...base, deliver: async (r) => { delivered.push(r.ts); }, open, watchPid: 4242, aliveImpl: () => false, pollMs: 60000, onExit: (why) => exits.push(why) });
  h.onRow(row('1.1'), 'acme');
  await l.idle();
  assert.deepEqual(delivered, [], 'nothing typed into the shell the agent left behind');
  assert.equal(l.stopped, true);
  assert.deepEqual(exits, ['agent process 4242 exited']);
});

test('the listener stops when the watched agent process exits', async () => {
  const { h, open } = fakeOpen();
  let up = true; const exits = [];
  const l = createListener({ ...base, deliver: async () => {}, open, watchPid: 4242, aliveImpl: () => up, pollMs: 5, onExit: (why) => exits.push(why) });
  await new Promise(res => setTimeout(res, 20));
  assert.equal(l.stopped, false);
  up = false;
  await new Promise(res => setTimeout(res, 30));
  assert.equal(l.stopped, true);
  assert.equal(h.stopped, true);
  assert.deepEqual(exits, ['agent process 4242 exited']);
});

test('stop() is idempotent', () => {
  const { open } = fakeOpen(); const exits = [];
  const l = createListener({ ...base, deliver: async () => {}, open, onExit: (w) => exits.push(w) });
  l.stop('a'); l.stop('b');
  assert.deepEqual(exits, ['a']);
});

test('main: bad usage is exit 2; no hub is exit 1; nothing routed is exit 0 with no pid file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'slk-listen-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const quiet = t.mock.method(console, 'error', () => {});
  assert.equal(await main(['--agent', 'codex'], {}, home), 2);
  assert.equal(await main(['--agent', 'codex', '--session', 'T', '--dir', home], {}, home), 1, 'no config.json and no SLACKLINE_REMOTE');
  const env = { SLACKLINE_REMOTE: 'http://127.0.0.1:1', SLACKLINE_ROUTES_FILE: join(home, 'absent.json') };
  assert.equal(await main(['--agent', 'codex', '--session', 'T', '--dir', home], env, home), 0);
  assert.ok(!existsSync(join(home, '.slackline', 'run')) || readdirSync(join(home, '.slackline', 'run')).length === 0);
  assert.ok(quiet.mock.callCount() >= 2);
});

test('clearInbox removes this session\'s inbox files only; a missing inbox is fine', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slk-inbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ['muse-S-1-1791500000-000200.txt', 'muse-S-1-1791500000-000300.txt', 'muse-S-10-1.txt', 'muse-S-2-1.txt', 'codex-S-1-1.txt']) writeFileSync(join(dir, f), 'x');
  clearInbox('muse', 'S-1', dir);
  assert.deepEqual(readdirSync(dir).sort(), ['codex-S-1-1.txt', 'muse-S-10-1.txt', 'muse-S-2-1.txt']);
  assert.doesNotThrow(() => clearInbox('muse', 'S-1', join(dir, 'nope')));
});
