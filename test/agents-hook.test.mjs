// agents/hook.mjs is what an agent's SessionStart/SessionEnd hook runs. It executes inside
// someone's agent startup, so its contract is strict: never fail, never print, never start a
// second listener for a session that already has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHookInput, findAgentPid, findPane, ps, start, end } from '../agents/hook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTEN = join(ROOT, 'agents', 'listen.mjs');

// A fake HOME with a routes file mapping <home>/proj to one channel.
function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'slk-hook-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'proj')); mkdirSync(join(home, 'other')); mkdirSync(join(home, '.slackline'));
  writeFileSync(join(home, '.slackline', 'routes.json'),
    JSON.stringify({ defaults: [], routes: [{ dir: join(home, 'proj'), org: 'acme', channels: ['C1'] }] }));
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; };
  return { home, spawned, spawnImpl, input: (dir, session = 'T-1') => JSON.stringify({ session_id: session, cwd: join(home, dir), hook_event_name: 'SessionStart' }) };
}
const noPs = () => null;

test('parseHookInput accepts the field names agents actually use, and falls back safely', () => {
  assert.deepEqual(parseHookInput('{"session_id":"a","cwd":"/p"}', {}, '/c'), { session: 'a', dir: '/p' });
  assert.deepEqual(parseHookInput('{"sessionId":"b","workspace":"/w"}', {}, '/c'), { session: 'b', dir: '/w' });
  assert.deepEqual(parseHookInput('{"thread_id":"c"}', {}, '/c'), { session: 'c', dir: '/c' });
  assert.deepEqual(parseHookInput('{"threadId":"d"}', { SLACKLINE_SESSION_DIR: '/e' }, '/c'), { session: 'd', dir: '/e' });
  assert.deepEqual(parseHookInput('', { SLACKLINE_SESSION_ID: 'env-id' }, '/c'), { session: 'env-id', dir: '/c' });
  assert.deepEqual(parseHookInput('{ not json', {}, '/c'), { session: '', dir: '/c' });
  assert.deepEqual(parseHookInput('null', {}, '/c'), { session: '', dir: '/c' });
  assert.deepEqual(parseHookInput('{"session_id":"../../etc/x y"}', {}, '/c'), { session: '.._.._etc_x_y', dir: '/c' }, 'a session id becomes part of a file name');
});

test('findAgentPid walks up the process tree to the agent, past the shells in between', () => {
  const table = { 50: { ppid: 40, comm: 'sh', args: '/bin/sh /opt/slackline/agents/hook.sh start --agent codex' },
    40: { ppid: 30, comm: 'bash', args: 'bash -lc hook' }, 30: { ppid: 1, comm: 'codex', args: 'codex' } };
  assert.equal(findAgentPid('codex', 50, (pid) => table[pid] || null), 30);
  assert.equal(findAgentPid('muse', 50, (pid) => table[pid] || null), 0, 'no such ancestor');
  assert.equal(findAgentPid('codex', 50, noPs), 0, 'ps unavailable');
});

// The process tree seen on a real machine when Codex's shared app-server daemon runs the hook
// (docs/agents/codex.md): the hook's shell is the daemon's child, the daemon is its updater's
// child, and the updater's parent is the terminal of whichever session happened to start the
// daemon — a different session from the one the hook is for.
const DAEMON = '/home/you/.codex/packages/app-server-daemon/releases/0.162.0/bin/codex';
const daemonTree = {
  77: { ppid: 60, comm: 'hook.sh', args: '/bin/sh /opt/slackline/agents/hook.sh start --agent codex' },
  60: { ppid: 50, comm: 'codex', args: `${DAEMON} app-server --listen unix:// --analytics-default-enabled --managed-daemon` },
  50: { ppid: 40, comm: 'codex', args: `${DAEMON} app-server daemon pid-update-loop` },
  40: { ppid: 30, comm: 'codex', args: 'codex --dangerously-bypass-approvals-and-sandbox resume 00000000-0000-4000-8000-000000000000' },
  30: { ppid: 1, comm: 'bash', args: '-bash' },
};
const daemonPs = (pid) => daemonTree[pid] || null;

test('findAgentPid never returns the app-server daemon, its updater, or whatever started them', () => {
  assert.equal(findAgentPid('codex', 77, daemonPs), 0, 'the hook was run by the daemon: nothing in its ancestry belongs to this session');
  assert.equal(findAgentPid('codex', 60, daemonPs), 0, 'the daemon itself');
  assert.equal(findAgentPid('codex', 50, daemonPs), 0, 'its updater');
  // A session's own process nearer the hook than a daemon is still found: here a codex
  // terminal session that was itself started from a shell the daemon runs.
  const below = { 90: { ppid: 80, comm: 'sh', args: '/bin/sh /opt/slackline/agents/hook.sh start --agent codex' },
    80: { ppid: 70, comm: 'codex', args: 'codex --dangerously-bypass-hook-trust' },
    70: { ppid: 60, comm: 'bash', args: 'bash -lc codex' }, ...daemonTree };
  assert.equal(findAgentPid('codex', 90, (pid) => below[pid] || null), 80);
  // "app-server" must be a word of its own: a directory or a prompt that merely contains it
  // does not make a session look like the daemon.
  const named = { 5: { ppid: 1, comm: 'codex', args: 'codex -C /home/you/src/my-app-server-fork' } };
  assert.equal(findAgentPid('codex', 5, (pid) => named[pid] || null), 5);
  const prompt = { 5: { ppid: 1, comm: 'codex', args: 'codex "fix the app-server"' }, 6: { ppid: 1, comm: 'codex', args: 'codex --model x app-server' } };
  assert.equal(findAgentPid('codex', 5, (pid) => prompt[pid] || null), 5, 'a prompt that mentions app-server is a session');
  assert.equal(findAgentPid('codex', 6, (pid) => prompt[pid] || null), 6, 'only the first argument counts');
});

// F2: procps cuts the command line to $COLUMNS when it is exported, even into a pipe.
test('ps returns the whole command line even when COLUMNS is exported small', async () => {
  const pad = 'x'.repeat(200);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', pad], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const p = ps(child.pid, { ...process.env, COLUMNS: '20' });
    assert.ok(p, 'ps answered');
    assert.ok(p.args.endsWith(pad), `full args came back (${p.args.length} chars)`);
    assert.equal(p.ppid, process.pid);
    assert.equal(typeof p.tty, 'string', 'the controlling terminal is reported (\'?\' for none)');
  } finally { child.kill(); }
});

test('start spawns one detached listener with the session, directory, delivery mode and watched pid', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const table = { 77: { ppid: 60, comm: 'sh', args: '/bin/sh /opt/slackline/agents/hook.sh start --agent codex' }, 60: { ppid: 1, comm: 'codex', args: 'codex' } };
  const r = start({ agent: 'codex', input: input('proj'), env: {}, home, ppid: 77, spawnImpl, psImpl: (p) => table[p] || null });
  assert.equal(r, 'started');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, process.execPath);
  assert.deepEqual(spawned[0].args, [LISTEN, '--agent', 'codex', '--session', 'T-1', '--dir', join(home, 'proj'), '--deliver', 'native', '--watch-pid', '60']);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.stdio[0], 'ignore');
  assert.ok(existsSync(join(home, '.slackline', 'logs', 'listen-codex-T-1.log')));
});

const panes = (txt) => () => txt;
test('start in tmux mode passes the pane found from the watched process, the mode and the watched pid', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const table = { 1: null, 9: { ppid: 1, comm: 'muse', args: 'muse', tty: 'pts/5' } };
  // the pane is the one whose terminal is the watched process's tty; TMUX_PANE in the environment is ignored
  start({ agent: 'muse', input: input('proj', 'S-9'), env: { SLACKLINE_DELIVER_MUSE: 'tmux', TMUX_PANE: '%99' }, home, ppid: 9, spawnImpl, psImpl: (p) => table[p] || null, tmuxImpl: panes('%3 /dev/pts/2\n%7 /dev/pts/5\n') });
  assert.deepEqual(spawned[0].args.slice(1), ['--agent', 'muse', '--session', 'S-9', '--dir', join(home, 'proj'), '--deliver', 'tmux', '--watch-pid', '9', '--tmux-pane', '%7']);
});

test('findPane: the pane whose tty is the watched process\'s controlling tty', () => {
  const table = { 20: { ppid: 15, comm: 'muse', args: 'muse', tty: 'pts/5' } };
  const psImpl = (p) => table[p] || null;
  assert.equal(findPane(20, { tmuxImpl: panes('%1 /dev/pts/2\n%4 /dev/pts/5\n'), psImpl }), '%4');
  assert.equal(findPane(20, { tmuxImpl: panes('%1 /dev/pts/2\n%4 /dev/pts/55\n'), psImpl }), '', 'pts/5 is not pts/55');
});

test('findPane: an agent in an editor terminal inside a tmux pane is not the outer pane', () => {
  // The agent runs on pts/9 (the editor\'s pty); the tmux pane that holds the editor owns pts/3,
  // and is an ANCESTOR of the agent. Ancestry must not be used.
  const table = { 20: { ppid: 15, comm: 'muse', args: 'muse', tty: 'pts/9' }, 15: { ppid: 10, comm: 'code', args: 'code', tty: 'pts/3' }, 10: { ppid: 1, comm: 'bash', args: 'bash', tty: 'pts/3' } };
  assert.equal(findPane(20, { tmuxImpl: panes('%4 /dev/pts/3\n'), psImpl: (p) => table[p] || null }), '');
});

test('findPane: no terminal, tmux failing or empty output give ""', () => {
  const tty = (t) => () => ({ ppid: 1, comm: 'muse', args: 'muse', tty: t });
  assert.equal(findPane(20, { tmuxImpl: panes('%4 /dev/pts/5\n'), psImpl: tty('?') }), '');
  assert.equal(findPane(20, { tmuxImpl: panes('%4 /dev/pts/5\n'), psImpl: tty('') }), '');
  assert.equal(findPane(20, { tmuxImpl: panes('%4 /dev/pts/5\n'), psImpl: noPs }), '');
  assert.equal(findPane(20, { tmuxImpl: () => { throw new Error('no tmux (or timed out)'); }, psImpl: tty('pts/5') }), '');
  assert.equal(findPane(20, { tmuxImpl: panes(''), psImpl: tty('pts/5') }), '');
});

test('tmux delivery with no pane for the session: no listener, one log line with ids only', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const table = { 9: { ppid: 1, comm: 'muse', args: 'muse', tty: 'pts/8' } };
  const env = { SLACKLINE_DELIVER_MUSE: 'tmux', TMUX_PANE: '%5' };
  const common = { agent: 'muse', env, home, ppid: 9, spawnImpl, psImpl: (p) => table[p] || null };
  assert.equal(start({ ...common, input: input('proj', 'S-4'), tmuxImpl: panes('%1 /dev/pts/5\n') }), 'no-pane');
  assert.equal(start({ ...common, input: input('proj', 'S-5'), tmuxImpl: () => { throw new Error('x'); } }), 'no-pane');
  assert.equal(spawned.length, 0);
  const log = join(home, '.slackline', 'logs', 'hook-muse.log');
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session S-4: the session's muse process is not inside a tmux pane, so tmux delivery cannot reach it and push is off for this session$/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('native delivery never asks tmux', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const table = { 9: { ppid: 1, comm: 'muse', args: 'muse' } };
  let asked = 0;
  assert.equal(start({ agent: 'muse', input: input('proj', 'S-6'), env: { SLACKLINE_DELIVER_MUSE: 'native' }, home, ppid: 9, spawnImpl, psImpl: (p) => table[p] || null, tmuxImpl: () => { asked++; return ''; } }), 'started');
  assert.equal(asked, 0);
  assert.ok(!spawned[0].args.includes('--tmux-pane'));
});

test('start does nothing when there is no session id, nothing is routed, or a listener is already running', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const common = { agent: 'codex', env: {}, home, ppid: 1, spawnImpl, psImpl: noPs };
  assert.equal(start({ ...common, input: '' }), 'no-session');
  assert.equal(start({ ...common, input: '{ not json' }), 'no-session');
  assert.equal(start({ ...common, input: input('other') }), 'no-channels');
  mkdirSync(join(home, '.slackline', 'run'), { recursive: true });
  writeFileSync(join(home, '.slackline', 'run', 'codex-T-1.pid'), '4242');
  const table = { 4242: { ppid: 1, comm: 'node', args: `/usr/bin/node ${LISTEN} --agent codex --session T-1 --dir /p --deliver native --watch-pid 60` } };
  assert.equal(start({ ...common, input: input('proj'), aliveImpl: () => true, psImpl: (p) => table[p] || null }), 'already-running', 'resuming a session fires SessionStart again');
  assert.equal(spawned.length, 0);
});

test('start replaces a stale pid file left by a listener that died', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  mkdirSync(join(home, '.slackline', 'run'), { recursive: true });
  writeFileSync(join(home, '.slackline', 'run', 'codex-T-1.pid'), '4999999');
  const table = { 77: { ppid: 1, comm: 'codex', args: 'codex' } };
  assert.equal(start({ agent: 'codex', input: input('proj'), env: {}, home, ppid: 77, spawnImpl, psImpl: (p) => table[p] || null, aliveImpl: () => false }), 'started');
  assert.equal(spawned.length, 1);
});

// `codex queue` accepts a message for a session that has been closed, so on native delivery a
// Codex listener has only the process it watches to tell it the session is over.
test('codex on native delivery starts no listener when there is no session-owned process to watch, and says so in a log', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const log = join(home, '.slackline', 'logs', 'hook-codex.log');
  assert.equal(start({ agent: 'codex', input: input('proj', 'T-7'), env: {}, home, ppid: 77, spawnImpl, psImpl: daemonPs }), 'no-watch');
  assert.equal(spawned.length, 0);
  assert.ok(!existsSync(join(home, '.slackline', 'run', 'codex-T-7.pid')));
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session T-7: no session-owned codex process to watch, so push is off for this session$/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(start({ agent: 'codex', input: input('proj', 'T-8'), env: {}, home, ppid: 1, spawnImpl, psImpl: noPs }), 'no-watch', 'ps unavailable is the same case');
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2, 'appended, not overwritten');
  assert.equal(start({ agent: 'codex', input: input('other', 'T-9'), env: {}, home, ppid: 77, spawnImpl, psImpl: daemonPs }), 'no-channels', 'nothing routed: nothing to say');
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 2);
});

// The tmux pane a listener types into is found from the session's own process, since the hook's
// environment can name another session's pane (the daemon). So tmux delivery needs a session-owned process too.
test('codex starts no listener in either delivery mode without a session-owned process; tmux muse likewise', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const lines = (a) => readFileSync(join(home, '.slackline', 'logs', `hook-${a}.log`), 'utf8').split('\n').filter(Boolean);
  assert.equal(start({ agent: 'codex', input: input('proj', 'T-2'), env: { SLACKLINE_DELIVER_CODEX: 'tmux', TMUX_PANE: '%5' }, home, ppid: 77, spawnImpl, psImpl: daemonPs }), 'no-watch');
  assert.equal(lines('codex').length, 1);
  assert.match(lines('codex')[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session T-2: no session-owned codex process to watch, so push is off for this session$/);
  assert.equal(start({ agent: 'muse', input: input('proj', 'S-2'), env: { SLACKLINE_DELIVER_MUSE: 'tmux', TMUX_PANE: '%5' }, home, ppid: 1, spawnImpl, psImpl: noPs }), 'no-watch');
  const log = join(home, '.slackline', 'logs', 'hook-muse.log');
  assert.match(lines('muse')[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session S-2: no session-owned muse process to watch, so push is off for this session$/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(spawned.length, 0);
  assert.ok(!existsSync(join(home, '.slackline', 'run', 'muse-S-2.pid')));
});

test('muse on native delivery still starts with nothing to watch: its own CLI reports a vanished session', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  assert.equal(start({ agent: 'muse', input: input('proj', 'S-1'), env: {}, home, ppid: 1, spawnImpl, psImpl: noPs }), 'started');
  assert.deepEqual(spawned[0].args.slice(1), ['--agent', 'muse', '--session', 'S-1', '--dir', join(home, 'proj'), '--deliver', 'native']);
  assert.ok(!existsSync(join(home, '.slackline', 'logs', 'hook-muse.log')));
});

test('SLACKLINE_HOOK_DEBUG=1 saves the raw hook input for inspection', (t) => {
  const { home, spawnImpl, input } = sandbox(t);
  const text = input('other');
  start({ agent: 'muse', input: text, env: { SLACKLINE_HOOK_DEBUG: '1' }, home, ppid: 1, spawnImpl, psImpl: noPs });
  assert.equal(readFileSync(join(home, '.slackline', 'logs', 'hook-muse-last.json'), 'utf8'), text);
});

test('end signals the session\'s listener and removes its pid file', (t) => {
  const { home, input } = sandbox(t);
  mkdirSync(join(home, '.slackline', 'run'), { recursive: true });
  const pidFile = join(home, '.slackline', 'run', 'codex-T-1.pid');
  writeFileSync(pidFile, '4242');
  const killed = [];
  const table = { 4242: { ppid: 1, comm: 'node', args: `/usr/bin/node ${LISTEN} --agent codex --session T-1 --dir /p --deliver native` } };
  assert.equal(end({ agent: 'codex', input: input('proj'), env: {}, home, aliveImpl: () => true, psImpl: (p) => table[p] || null, killImpl: (pid, sig) => killed.push([pid, sig]) }), 'stopped');
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  assert.ok(!existsSync(pidFile));
  assert.equal(end({ agent: 'codex', input: input('proj'), env: {}, home, killImpl: () => { throw new Error('must not be called'); } }), 'not-running');
  assert.equal(end({ agent: 'codex', input: '', env: {}, home }), 'no-session');
});

test('hook.sh exits 0 and prints nothing, with or without the installer\'s env file', (t) => {
  const { home } = sandbox(t);
  const sh = (input) => spawnSync('sh', [join(ROOT, 'agents', 'hook.sh'), 'start', '--agent', 'codex'],
    { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  const bare = sh('{"session_id":"T-1"}');
  assert.deepEqual([bare.status, bare.stdout, bare.stderr], [0, '', ''], 'no agents.env: a silent no-op');
  writeFileSync(join(home, '.slackline', 'agents.env'), `SLACKLINE_REPO='${ROOT}'\nSLACKLINE_NODE='${process.execPath}'\nSLACKLINE_DELIVER_CODEX=native\n`);
  for (const input of ['', '{ not json', JSON.stringify({ session_id: 'T-1', cwd: join(home, 'other') })]) {
    const r = sh(input);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `input ${JSON.stringify(input)}`);
  }
});

test('hook.sh is a silent no-op, exit 0, on a garbage agents.env', (t) => {
  const { home } = sandbox(t);
  const env = join(home, '.slackline', 'agents.env');
  const good = { SLACKLINE_REPO: `SLACKLINE_REPO='${ROOT}'`, SLACKLINE_NODE: `SLACKLINE_NODE='${process.execPath}'` };
  const cases = {
    'unterminated quote': "SLACKLINE_NODE='oops\n",
    'FOO=(': 'FOO=(\n',
    'no node or repo': 'SLACKLINE_DELIVER_CODEX=native\n',
    'no repo': `${good.SLACKLINE_NODE}\n`,
    'no node': `${good.SLACKLINE_REPO}\n`,
    'node missing': `${good.SLACKLINE_REPO}\nSLACKLINE_NODE='${home}/nope'\n`,
    'node fails': `${good.SLACKLINE_REPO}\nSLACKLINE_NODE='/bin/false'\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    writeFileSync(env, text);
    const r = spawnSync('sh', [join(ROOT, 'agents', 'hook.sh'), 'start', '--agent', 'codex'],
      { input: '{"session_id":"T-1"}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], name);
  }
});

test('hook.sh passes its stdin through to hook.mjs', (t) => {
  const { home } = sandbox(t);
  writeFileSync(join(home, '.slackline', 'agents.env'), `SLACKLINE_REPO='${ROOT}'\nSLACKLINE_NODE='${process.execPath}'\n`);
  spawnSync('sh', [join(ROOT, 'agents', 'hook.sh'), 'start', '--agent', 'muse'],
    { input: '{"session_id":"S-1"}', env: { PATH: process.env.PATH, HOME: home, SLACKLINE_HOOK_DEBUG: '1' } });
  assert.equal(readFileSync(join(home, '.slackline', 'logs', 'hook-muse-last.json'), 'utf8'), '{"session_id":"S-1"}');
});

// ---- a pid file is trusted only if the process is this session's listener ----

const listenCmd = (agent, session, watch) => `/usr/bin/node ${LISTEN} --agent ${agent} --session ${session} --dir /p --deliver native --watch-pid ${watch}`;
const runDir = (home) => { const d = join(home, '.slackline', 'run'); mkdirSync(d, { recursive: true }); return d; };

test('a pid file whose number belongs to an unrelated live process is stale: start removes it and starts', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const file = join(runDir(home), 'codex-T-1.pid');
  writeFileSync(file, '4242');
  const table = { 4242: { ppid: 1, comm: 'vim', args: 'vim notes.txt' }, 77: { ppid: 1, comm: 'codex', args: 'codex' } };
  const r = start({ agent: 'codex', input: input('proj'), env: {}, home, ppid: 77, spawnImpl, aliveImpl: () => true, psImpl: (p) => table[p] || null });
  assert.equal(r, 'started');
  assert.equal(spawned.length, 1);
  assert.ok(!existsSync(file), 'the stale file was removed');
});

test('a listener of ANOTHER session is not "already running" for this one', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  writeFileSync(join(runDir(home), 'codex-T-1.pid'), '4242');
  const table = { 4242: { ppid: 1, comm: 'node', args: listenCmd('codex', 'T-10', 60) }, 77: { ppid: 1, comm: 'codex', args: 'codex' } };
  assert.equal(start({ agent: 'codex', input: input('proj'), env: {}, home, ppid: 77, spawnImpl, aliveImpl: () => true, psImpl: (p) => table[p] || null }), 'started', '--session T-10 is not --session T-1');
  assert.equal(spawned.length, 1);
});

test('end never signals a stranger that inherited a stale pid, and removes the file', (t) => {
  const { home, input } = sandbox(t);
  const file = join(runDir(home), 'codex-T-1.pid');
  writeFileSync(file, '4242');
  const table = { 4242: { ppid: 1, comm: 'vim', args: 'vim notes.txt' } };
  assert.equal(end({ agent: 'codex', input: input('proj'), env: {}, home, aliveImpl: () => true, psImpl: (p) => table[p] || null, killImpl: () => { throw new Error('must not signal'); } }), 'not-running');
  assert.ok(!existsSync(file));
});

// ---- a new session of the same agent process replaces the old session's listener ----

test('start stops an older listener of the same agent that watches the same process, and leaves the others', (t) => {
  const { home, spawned, spawnImpl, input } = sandbox(t);
  const d = runDir(home);
  const files = { 'codex-OLD.pid': 5001, 'codex-ELSEWHERE.pid': 5002, 'muse-OLD.pid': 5003, 'codex-STALE.pid': 5004, 'codex-DEAD.pid': 5005 };
  for (const [f, pid] of Object.entries(files)) writeFileSync(join(d, f), String(pid));
  const table = {
    77: { ppid: 1, comm: 'codex', args: 'codex' },
    5001: { ppid: 1, comm: 'node', args: listenCmd('codex', 'OLD', 77) },          // same agent, same watched process -> stopped
    5002: { ppid: 1, comm: 'node', args: listenCmd('codex', 'ELSEWHERE', 88) },    // another process -> left
    5003: { ppid: 1, comm: 'node', args: listenCmd('muse', 'OLD', 77) },           // another agent -> left
    5004: { ppid: 1, comm: 'vim', args: `vim --watch-pid 77 ${LISTEN}x` },         // not a listener -> left alone
  };
  const killed = [];
  const r = start({ agent: 'codex', input: input('proj', 'NEW'), env: {}, home, ppid: 77, spawnImpl, aliveImpl: (pid) => pid !== 5005,
    psImpl: (p) => table[p] || null, killImpl: (pid, sig) => killed.push([pid, sig]) });
  assert.equal(r, 'started');
  assert.deepEqual(killed, [[5001, 'SIGTERM']]);
  assert.ok(!existsSync(join(d, 'codex-OLD.pid')));
  for (const f of ['codex-ELSEWHERE.pid', 'muse-OLD.pid', 'codex-STALE.pid', 'codex-DEAD.pid']) assert.ok(existsSync(join(d, f)), `${f} left alone`);
  assert.equal(spawned.length, 1);
});
