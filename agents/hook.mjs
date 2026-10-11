#!/usr/bin/env node
// What an agent's SessionStart / SessionEnd hook runs (through agents/hook.sh):
//
//   hook.mjs start --agent <codex|muse>     start this session's listener, if anything is routed
//   hook.mjs end   --agent <codex|muse>     stop it
//
// The agent passes the hook a JSON object on stdin (session id, working directory).
//
// This code runs inside someone's agent startup, so the contract is strict:
//   - it never fails the agent: every problem ends in exit 0;
//   - it prints nothing on stdout — agents may add a hook's stdout to the session's context;
//   - it returns at once: the listener is started detached, not waited for;
//   - it never starts a second listener: resuming a session fires SessionStart again;
//   - it never starts a listener it would have no way to stop or no safe place to type (see start()).
// Set SLACKLINE_HOOK_DEBUG=1 to save the raw hook input to ~/.slackline/logs/hook-<agent>-last.json.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveRoute } from './route.mjs';
import { alive } from './listen.mjs';

const LISTEN = join(dirname(fileURLToPath(import.meta.url)), 'listen.mjs');

// Agents do not agree on field names, and the session id ends up in a file name — so accept
// the known spellings and reduce the id to filename-safe characters.
export function parseHookInput(text, env = process.env, cwd = process.cwd()) {
  let j = null;
  try { j = JSON.parse(text || 'null'); } catch {}
  if (!j || typeof j !== 'object') j = {};
  const session = j.session_id || j.sessionId || j.thread_id || j.threadId || env.SLACKLINE_SESSION_ID || '';
  const dir = j.cwd || j.workspace || j.workspace_root || env.SLACKLINE_SESSION_DIR || cwd;
  return { session: String(session).replace(/[^A-Za-z0-9._-]/g, '_'), dir: String(dir) };
}

// One process: its parent, its command name, its full command line and its controlling terminal
// (`pts/5`, or `?` for none). Separate `ps` calls, because a command name may contain spaces and
// so cannot be split from the arguments on one line.
// `-ww` matters: procps cuts the command line to $COLUMNS when that is exported, even into a
// pipe, and the daemon's `app-server` word starts past column 100.
export function ps(pid, env = process.env) {
  const ask = (fmt) => execFileSync('ps', ['-ww', '-o', fmt, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
  try {
    const m = ask('ppid=,comm=').match(/^(\d+)\s+(.*)$/);
    return m ? { ppid: Number(m[1]), comm: m[2], args: ask('args='), tty: ask('tty=') } : null;
  } catch { return null; }
}

// Codex's shared app-server daemon and its updater are `codex` processes too (`codex app-server
// --listen … --managed-daemon`, `codex app-server daemon pid-update-loop`), but neither is a
// session: they outlive every session.
// A process is the daemon (or its updater) only when `app-server` is its first argument:
// `codex "fix the app-server"` is a session.
const isAppServer = (p) => (String(p.args || '').trim().split(/\s+/)[1] === 'app-server');

// The hook's parent is often a short-lived shell, which would make a useless thing to watch.
// Walk up to the nearest process of the agent: that is what ran the hook. 0 means "this
// session has no process of its own to watch".
//
// When that nearest process is the app-server daemon, the answer is 0 and the walk stops: the
// daemon runs hooks for every session, and what is above it is whatever happened to start the
// daemon. On the machine this was checked on (Codex 0.160.1 with a 0.162.0 daemon,
// docs/agents/codex.md) that was the terminal of a different, unrelated session — watching it
// would tie this session's listener to someone else's.
export function findAgentPid(agent, from, psImpl = ps) {
  let pid = from;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const p = psImpl(pid);
    if (!p) return 0;
    if (p.comm.toLowerCase().includes(agent)) return isAppServer(p) ? 0 : pid;
    pid = p.ppid;
  }
  return 0;
}

// The tmux pane a tmux-delivery listener types into: the pane whose terminal is the watched
// process's controlling terminal. It is derived from the session's own process, never read from
// the hook's environment, because the hook's environment is not the session's: Codex's shared
// daemon runs hooks with TMUX_PANE of an unrelated pane, and Muse hands its hooks no TMUX_PANE.
// Matching the terminal, not the process ancestry, is what keeps an agent running in an editor's
// terminal (or `screen`) inside a tmux pane from being mistaken for that outer pane: its tty is
// the editor's pty, which no pane owns. '' means there is no such pane (or tmux cannot be asked).
const listPanes = () => execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
export function findPane(pid, { tmuxImpl = listPanes, psImpl = ps } = {}) {
  const p = psImpl(pid);
  const tty = p && String(p.tty || '').trim();
  if (!tty || tty === '?') return '';
  let out = '';
  try { out = String(tmuxImpl() || ''); } catch { return ''; }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(%\d+) (\S+)$/);
    if (m && m[2] === `/dev/${tty}`) return m[1];
  }
  return '';
}

const dirs = (home) => ({ logs: `${home}/.slackline/logs`, run: `${home}/.slackline/run` });
const readPid = (file) => { try { return Number(readFileSync(file, 'utf8')) || 0; } catch { return 0; } };

// A pid file only counts when that pid is, right now, one of our listeners: a pid number is
// recycled, and a stale file whose number now belongs to an unrelated process must neither stop
// a resumed session from getting its listener nor make `end` signal a stranger. `session` set
// means that session's listener; unset, any session's. Returns the listener's argv or null.
function listenerArgs(pid, { session, aliveImpl, psImpl }) {
  if (!pid || !aliveImpl(pid)) return null;
  const p = psImpl(pid);
  const argv = p ? String(p.args || '').trim().split(/\s+/) : [];
  if (!argv.some(a => a.endsWith('listen.mjs'))) return null;
  if (session !== undefined && !argv.some((a, i) => a === '--session' && argv[i + 1] === session)) return null;
  return argv;
}

export function start({ agent, input, env = process.env, home = homedir(), cwd = process.cwd(), ppid = process.ppid,
  spawnImpl = spawn, aliveImpl = alive, psImpl = ps, tmuxImpl = listPanes, killImpl = (pid, sig) => process.kill(pid, sig) }) {
  const d = dirs(home);
  mkdirSync(d.logs, { recursive: true, mode: 0o700 });
  mkdirSync(d.run, { recursive: true, mode: 0o700 });
  if (env.SLACKLINE_HOOK_DEBUG === '1') writeFileSync(`${d.logs}/hook-${agent}-last.json`, input || '', { mode: 0o600 });
  const { session, dir } = parseHookInput(input, env, cwd);
  if (!session) return 'no-session';
  const ownFile = `${d.run}/${agent}-${session}.pid`;
  const old = readPid(ownFile);
  if (listenerArgs(old, { session, aliveImpl, psImpl })) return 'already-running';
  if (old) { try { rmSync(ownFile); } catch {} }                    // stale: not a listener of this session
  if (!resolveRoute(dir, { file: env.SLACKLINE_ROUTES_FILE || `${home}/.slackline/routes.json` }).length) return 'no-channels';

  const mode = env[`SLACKLINE_DELIVER_${agent.toUpperCase()}`] === 'tmux' ? 'tmux' : 'native';
  const args = [LISTEN, '--agent', agent, '--session', session, '--dir', dir, '--deliver', mode];
  const watch = findAgentPid(agent, ppid, psImpl);
  // `codex queue` accepts a message for a session that has been closed (exit 0, nothing on
  // stderr), so on native delivery a Codex listener can never learn from a delivery that its
  // session is over. And when the shared daemon ran the session, SessionEnd was not seen
  // when its terminal exited or was closed (docs/agents/codex.md). The watched process is
  // then the only thing that ends the listener: with none to watch, start none. The tmux
  // route needs one too: the pane it types into is found from that process (findPane), because
  // TMUX_PANE of whatever ran this hook is someone else's pane on Codex's daemon and absent on
  // Muse. Only Muse on native delivery may go without: its own
  // CLI reports a vanished session.
  if (!watch && (agent === 'codex' || mode === 'tmux')) {
    appendFileSync(`${d.logs}/hook-${agent}.log`, `${new Date().toISOString()} session ${session}: no session-owned ${agent} process to watch, so push is off for this session\n`, { mode: 0o600 });
    return 'no-watch';
  }
  // A running agent can replace its session without firing SessionEnd (/new, /clear, an in-app
  // resume). The previous session's listener is then still watching the same agent process and
  // would deliver to the abandoned session beside the new one: stop it. Only listeners of this
  // agent that are provably listeners, watching this very process.
  if (watch) {
    let files = [];
    try { files = readdirSync(d.run).filter(f => f.startsWith(`${agent}-`) && f.endsWith('.pid') && `${d.run}/${f}` !== ownFile); } catch {}
    for (const f of files) {
      const file = `${d.run}/${f}`, argv = listenerArgs(readPid(file), { aliveImpl, psImpl });
      if (!argv || !argv.some((a, i) => a === '--watch-pid' && argv[i + 1] === String(watch))) continue;
      try { killImpl(readPid(file), 'SIGTERM'); } catch {}
      try { rmSync(file); } catch {}
    }
  }
  let pane = '';
  if (mode === 'tmux') {
    pane = findPane(watch, { tmuxImpl, psImpl });
    if (!pane) {
      appendFileSync(`${d.logs}/hook-${agent}.log`, `${new Date().toISOString()} session ${session}: the session's ${agent} process is not inside a tmux pane, so tmux delivery cannot reach it and push is off for this session\n`, { mode: 0o600 });
      return 'no-pane';
    }
  }
  if (watch) args.push('--watch-pid', String(watch));
  if (pane) args.push('--tmux-pane', pane);
  const out = openSync(`${d.logs}/listen-${agent}-${session}.log`, 'a', 0o600);
  spawnImpl(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env }).unref();
  return 'started';
}

export function end({ agent, input, env = process.env, home = homedir(), cwd = process.cwd(), killImpl = (pid, sig) => process.kill(pid, sig),
  aliveImpl = alive, psImpl = ps }) {
  const { session } = parseHookInput(input, env, cwd);
  if (!session) return 'no-session';
  const file = `${dirs(home).run}/${agent}-${session}.pid`;
  const pid = readPid(file);
  if (!pid) return 'not-running';
  const live = listenerArgs(pid, { session, aliveImpl, psImpl });
  if (live) { try { killImpl(pid, 'SIGTERM'); } catch {} }
  try { rmSync(file); } catch {}                                    // a stale file is removed, never signalled
  return live ? 'stopped' : 'not-running';
}

// A hook runner that leaves stdin open must not hang the agent's startup: give it two seconds.
function readStdin(ms = 2000) {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('');
    let s = '';
    const timer = setTimeout(() => res(s), ms);
    const done = () => { clearTimeout(timer); res(s); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

const self = (() => { try { return pathToFileURL(resolvePath(process.argv[1] || '')).href; } catch { return ''; } })();
if (import.meta.url === self) {
  try {
    const [verb, ...rest] = process.argv.slice(2);
    const agent = rest[rest.indexOf('--agent') + 1];
    if (['start', 'end'].includes(verb) && ['codex', 'muse'].includes(agent)) {
      const input = await readStdin();
      (verb === 'start' ? start : end)({ agent, input });
    }
  } catch {}
  process.exit(0);
}
