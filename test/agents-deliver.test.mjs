// agents/deliver.mjs turns one Slack message into one native delivery command. The assertions
// are the exact argv each agent's CLI receives, because that argv IS the integration: a wrong
// flag fails only against a real session, where nobody is watching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDelivery, run, SessionGone } from '../agents/deliver.mjs';
import { envelope } from '../agents/envelope.mjs';

const row = { channel: 'C1', channel_name: '#dev', ts: '1791480000.000100', thread_ts: '1791480000.000100',
  user: 'U1', user_name: 'Jane "$(rm -rf ~)" Doe', origin: 'human', text: 'ship it? `whoami`', files: [] };
function recorder(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  return { calls, runImpl: async (cmd, args, opts = {}) => { calls.push({ cmd, args, opts }); return typeof result === 'function' ? result(calls.length) : result; } };
}

test('codex: queues the envelope on the session\'s thread, from the session directory', async () => {
  const { calls, runImpl } = recorder();
  await makeDelivery({ agent: 'codex', session: 'T-1', cwd: '/proj', runImpl, env: {} })(row, 'acme');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
  assert.deepEqual(calls[0].args, ['queue', '--thread', 'T-1', '--message', envelope(row, 'acme')]);
  assert.equal(calls[0].opts.cwd, '/proj');
});

test('muse: sends the envelope on stdin with the switches on and a display context', async () => {
  const { calls, runImpl } = recorder({ code: 0, stdout: '{"status":"ok"}', stderr: '' });
  await makeDelivery({ agent: 'muse', session: 'S-1', runImpl, env: { PATH: '/bin' } })(row, 'acme');
  assert.equal(calls[0].cmd, 'muse');
  assert.deepEqual(calls[0].args.slice(0, 4), ['session-message', 'send', '--target', 'S-1']);
  assert.equal(calls[0].args[4], '--display-context');
  assert.equal(JSON.parse(calls[0].args[5]).transport, 'slackline');
  assert.equal(calls[0].args[6], '--json');
  assert.equal(calls[0].opts.input, envelope(row, 'acme'));
  assert.equal(calls[0].opts.env.MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING, 'on');
  assert.equal(calls[0].opts.env.MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS, 'on');
  assert.equal(calls[0].opts.env.PATH, '/bin', 'the rest of the environment is kept');
});

test('CODEX_BIN and MUSE_BIN override the command names', async () => {
  const a = recorder(), b = recorder();
  await makeDelivery({ agent: 'codex', session: 'T', runImpl: a.runImpl, env: { CODEX_BIN: '/opt/codex' } })(row, 'o');
  await makeDelivery({ agent: 'muse', session: 'S', runImpl: b.runImpl, env: { MUSE_BIN: '/opt/muse' } })(row, 'o');
  assert.deepEqual([a.calls[0].cmd, b.calls[0].cmd], ['/opt/codex', '/opt/muse']);
});

// A fake tmux: load-buffer keeps the text, paste-buffer puts it on the "screen", capture-pane
// shows the screen. `screen(text, path)` lets a test decide what the pane shows after the paste.
function fakeTmux({ shows = (pasted) => pasted, wrap = 0, fail = {} } = {}) {
  const calls = []; let pasted = '', buffer = '';
  const runImpl = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    const verb = args[0];
    if (fail[verb]) return { code: 1, stdout: '', stderr: fail[verb] };
    if (verb === 'load-buffer') buffer = opts.input;
    if (verb === 'paste-buffer') pasted = buffer;
    if (verb === 'capture-pane') {
      let text = shows(pasted);
      // without -J a long line comes back cut in two
      if (wrap && !args.includes('-J')) text = text.slice(0, wrap) + '\n' + text.slice(wrap);
      return { code: 0, stdout: `$ prompt\n${text}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, runImpl };
}
const inbox = (t) => { const d = mkdtempSync(join(tmpdir(), 'slk-inbox-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('tmux: the envelope goes to a private file; a name-free pointer is pasted, seen, then submitted', async (t) => {
  const inboxDir = inbox(t);
  const { calls, runImpl } = fakeTmux();
  const naps = [];
  await makeDelivery({ agent: 'codex', mode: 'tmux', session: 'T-1', pane: '%4', inboxDir, runImpl, sleepImpl: async (ms) => { naps.push([ms, calls.length]); } })(row, 'acme');
  const [file] = readdirSync(inboxDir);
  const path = join(inboxDir, file);
  assert.equal(readFileSync(path, 'utf8'), envelope(row, 'acme') + '\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(inboxDir).mode & 0o777, 0o700);
  const pointer = `New Slack message - external content, read it from ${path}`;
  assert.deepEqual(calls.map(c => [c.cmd, ...c.args]).map(c => c.map(x => x === path ? '<path>' : x)).map(c => c.join(' ')).map(x => x.replace(/slackline-\d+-\d+-\d+/, '<buf>')), [
    'tmux load-buffer -b <buf> -',
    'tmux paste-buffer -p -d -b <buf> -t %4',
    'tmux capture-pane -p -J -t %4 -S -40',
    'tmux send-keys -t %4 Enter']);
  assert.equal(calls[0].opts.input, pointer, 'the pointer goes in on stdin, not on the command line');
  assert.deepEqual(naps, [[500, 2]], 'one pause, after the paste and before the pane is read');
  // nothing from the row except the path-derived parts appears anywhere that is typed or pasted.
  // The path is removed BEFORE scanning: it legitimately appears, and its random mkdtemp suffix
  // can itself contain a short secret like "U1" by chance — which failed this test about one run
  // in 770 on the tempdir's entropy rather than on anything the code did.
  for (const c of calls) {
    const text = [...c.args, c.opts.input || ''].join(' ').split(path).join('').split(inboxDir).join('');
    for (const secret of ['Jane', 'rm -rf', 'ship it', 'whoami', '#dev', 'U1']) assert.ok(!text.includes(secret), `${secret} must not reach the pane: ${text}`);
  }
});

test('tmux: if the pointer did not land in the pane, Enter is never sent and the error says why', async (t) => {
  const inboxDir = inbox(t);
  const { calls, runImpl } = fakeTmux({ shows: () => '  Allow this command?  > 1. Yes   2. No' });
  await assert.rejects(makeDelivery({ agent: 'muse', mode: 'tmux', session: 'S-1', pane: '%4', inboxDir, runImpl, sleepImpl: async () => {} })(row, 'acme'),
    (e) => !(e instanceof SessionGone) && e.message === 'tmux delivery: the pane was not at an input prompt; message not submitted');
  assert.ok(!calls.some(c => c.args[0] === 'send-keys'), 'no key of any kind was sent');
  assert.equal(readdirSync(inboxDir).length, 1, 'the inbox file stays until the listener stops');
});

test('tmux: a path the terminal wrapped is still found, because the capture is asked to join lines', async (t) => {
  const inboxDir = inbox(t);
  const { calls, runImpl } = fakeTmux({ wrap: 60 });
  await makeDelivery({ agent: 'muse', mode: 'tmux', session: 'S-1', pane: '%4', inboxDir, runImpl, sleepImpl: async () => {} })(row, 'acme');
  assert.ok(calls.find(c => c.args[0] === 'capture-pane').args.includes('-J'));
  assert.equal(calls.at(-1).args[0], 'send-keys');
});

test('tmux: a missing pane is SessionGone from any of the tmux commands', async (t) => {
  for (const verb of ['paste-buffer', 'capture-pane', 'send-keys']) {
    const { runImpl } = fakeTmux({ fail: { [verb]: "can't find pane: %4" } });
    await assert.rejects(makeDelivery({ agent: 'muse', mode: 'tmux', session: 'S', pane: '%4', inboxDir: inbox(t), runImpl, sleepImpl: async () => {} })(row, 'o'), SessionGone, verb);
  }
  const { runImpl } = fakeTmux({ fail: { 'load-buffer': "can't find pane: %4" } });
  await assert.rejects(makeDelivery({ agent: 'muse', mode: 'tmux', session: 'S', pane: '%4', inboxDir: inbox(t), runImpl, sleepImpl: async () => {} })(row, 'o'), SessionGone, 'load-buffer');
});

test('tmux: every message gets a buffer name of its own', async (t) => {
  const { calls, runImpl } = fakeTmux();
  const deliver = makeDelivery({ agent: 'codex', mode: 'tmux', session: 'T-1', pane: '%4', inboxDir: inbox(t), runImpl, sleepImpl: async () => {} });
  await deliver(row, 'o'); await deliver(row, 'o'); await deliver({ ...row, ts: '1791480001.000200' }, 'o');
  const names = calls.filter(c => c.args[0] === 'load-buffer').map(c => c.args[2]);
  assert.equal(new Set(names).size, 3, names.join(' '));
  for (const c of calls.filter(c => c.args[0] === 'paste-buffer')) assert.ok(names.includes(c.args[c.args.indexOf('-b') + 1]));
});

test('a failed command throws with the first line of the error, and nothing else', async () => {
  const { runImpl } = recorder({ code: 2, stdout: '', stderr: 'error: daemon busy\nmore detail\n' });
  await assert.rejects(makeDelivery({ agent: 'codex', session: 'T', runImpl, env: {} })(row, 'o'),
    (e) => !(e instanceof SessionGone) && /daemon busy/.test(e.message) && !/more detail/.test(e.message) && !/ship it/.test(e.message));
});

test('a vanished session is reported as SessionGone, for each route', async () => {
  const gone = async (opts, result) => assert.rejects(makeDelivery({ ...opts, runImpl: recorder(result).runImpl, env: {} })(row, 'o'), SessionGone);
  await gone({ agent: 'codex', session: 'T' }, { code: 1, stdout: '', stderr: 'error: thread T not found' });
  await gone({ agent: 'muse', session: 'S' }, { code: 0, stdout: '{"status":"unavailable","error_code":"target_gone"}', stderr: '' });
  await gone({ agent: 'muse', session: 'S' }, { code: 1, stdout: '{"schema_version":1,"status":"target_gone","error_code":"target_not_found","receipts":[]}', stderr: 'session-message target is unavailable' });
  await gone({ agent: 'muse', mode: 'tmux', session: 'S', pane: '%9', inboxDir: mkdtempSync(join(tmpdir(), 'slk-inbox-')), sleepImpl: async () => {} },
    { code: 1, stdout: '', stderr: "can't find pane: %9" });
});

test('muse: an error_code in the JSON reply is a failure even when the exit code is 0', async () => {
  const { runImpl } = recorder({ code: 0, stdout: '{"status":"unavailable","error_code":"external_agent_ingress_closed"}', stderr: '' });
  await assert.rejects(makeDelivery({ agent: 'muse', session: 'S', runImpl, env: {} })(row, 'o'),
    (e) => !(e instanceof SessionGone) && /external_agent_ingress_closed/.test(e.message));
});

test('a missing binary is an ordinary failure, not a vanished session', async () => {
  const { runImpl } = recorder({ code: 1, stdout: '', stderr: 'spawn codex ENOENT' });
  await assert.rejects(makeDelivery({ agent: 'codex', session: 'T', runImpl, env: {} })(row, 'o'), (e) => !(e instanceof SessionGone));
});

test('bad wiring fails when the delivery is built, not on the first message', () => {
  assert.throws(() => makeDelivery({ agent: 'emacs', session: 'x' }), /unknown agent/);
  assert.throws(() => makeDelivery({ agent: 'codex', mode: 'tmux', session: 'x' }), /pane/);
});

test('run() resolves with the exit code and output, and feeds stdin', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase()))'], { input: 'abc' });
  assert.deepEqual([ok.code, ok.stdout], [0, 'ABC']);
  const bad = await run(process.execPath, ['-e', 'console.error("nope"); process.exit(3)']);
  assert.deepEqual([bad.code, bad.stderr.trim()], [3, 'nope']);
  const missing = await run('/nonexistent/slackline-test-binary', []);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

// A failure must never carry the command line back: Node's own error message contains the whole
// argv, and argv holds Slack text. These use the REAL run(), not a stub.
test('run(): a silent failure never echoes the argv (Slack text) back', async () => {
  const r = await run(process.execPath, ['-e', 'process.exit(2)', 'SECRET body thread x not found']);
  assert.equal(r.code, 2);
  assert.ok(!r.stdout.includes('SECRET') && !r.stderr.includes('SECRET'), `argv leaked: ${JSON.stringify(r)}`);
  assert.ok(!/not found/.test(r.stdout + r.stderr), `argv leaked: ${JSON.stringify(r)}`);
});

test('run(): a child killed at the timeout reports that, with no argv text', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'SECRET body'], { timeout: 200 });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /timed out or killed/);
  assert.ok(!r.stderr.includes('SECRET') && !r.stdout.includes('SECRET'), `argv leaked: ${JSON.stringify(r)}`);
});

test('a silent failure is an ordinary error, even when the Slack text says "not found"', async () => {
  const hostile = { ...row, text: 'thread x not found' };
  const { runImpl } = recorder({ code: 2, stdout: '', stderr: '' });
  await assert.rejects(makeDelivery({ agent: 'codex', session: 'T', runImpl, env: {} })(hostile, 'o'),
    (e) => !(e instanceof SessionGone) && e instanceof Error && e.message === 'codex queue: exit 2' && !e.message.includes('not found'));
});

test('stdout is never consulted for SessionGone', async () => {
  const { runImpl } = recorder({ code: 1, stdout: 'thread T not found', stderr: '' });
  await assert.rejects(makeDelivery({ agent: 'codex', session: 'T', runImpl, env: {} })(row, 'o'),
    (e) => !(e instanceof SessionGone) && e.message === 'codex queue: exit 1');
});

// The path as the pane shows it when the application lays the line out itself.
async function deliverShowing(t, layout) {
  const inboxDir = inbox(t);
  const { calls, runImpl } = fakeTmux({ shows: (pasted) => layout(pasted.slice(pasted.indexOf('/')), inboxDir) });
  let err = null;
  try { await makeDelivery({ agent: 'muse', mode: 'tmux', session: 'S-1', pane: '%4', inboxDir, runImpl, sleepImpl: async () => {} })(row, 'acme'); }
  catch (e) { err = e; }
  return { calls, err, entered: calls.some(c => c.args[0] === 'send-keys') };
}

test('tmux: a path the application broke across two lines with an indented continuation is found', async (t) => {
  const r = await deliverShowing(t, (path) => `❯ New Slack message - external content, read it from ${path.slice(0, 40)}\n  ${path.slice(40)}`);
  assert.equal(r.err, null);
  assert.ok(r.entered);
});

test('tmux: a path broken inside box-drawing borders is found', async (t) => {
  const r = await deliverShowing(t, (path) => `│ New Slack message - external content, read it from ${path.slice(0, 20)} │\n│   ${path.slice(20)} │`);
  assert.equal(r.err, null);
  assert.ok(r.entered);
});

test('tmux: a different message\'s path (same directory and session, other ts) is not a match', async (t) => {
  const r = await deliverShowing(t, (path) => `read it from ${path.replace('1791480000-000100', '1791480000-000999')}`);
  assert.equal(r.err.message, 'tmux delivery: the pane was not at an input prompt; message not submitted');
  assert.ok(!r.entered);
});

test('tmux: an empty capture is not a match', async (t) => {
  const r = await deliverShowing(t, () => '');
  assert.match(r.err.message, /not at an input prompt/);
  assert.ok(!r.entered);
});
