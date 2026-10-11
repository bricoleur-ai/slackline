#!/usr/bin/env node
// The per-session listener for Codex and Muse: one process beside one agent session. It
// resolves the session's directory to channels (agents/route.mjs), holds the hub streams
// (agents/streams.mjs), and hands each message to the session through the agent's own CLI
// (agents/deliver.mjs). Started by the agent's SessionStart hook (agents/hook.mjs).
//
//   listen.mjs --agent <codex|muse> --session <id> --dir <path>
//              [--watch-pid <pid>] [--deliver native|tmux] [--tmux-pane <id>]
//
// It lives and dies with its session: it exits when the watched agent process is gone, when a
// delivery reports the session no longer exists, or on SIGTERM from the SessionEnd hook.
// Delivery is live and at most once — nothing is stored, nothing is retried (docs/agents.md, "What push does and does not do").
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { remoteConfig } from '../remote.mjs';
import { resolve as resolveRoute } from './route.mjs';
import { openStreams } from './streams.mjs';
import { makeDelivery, clearInbox, SessionGone } from './deliver.mjs';

// EPERM means the process exists but is not ours — still alive.
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const FLAGS = { '--agent': 'agent', '--session': 'session', '--dir': 'dir', '--watch-pid': 'watchPid', '--deliver': 'deliver', '--tmux-pane': 'tmuxPane' };
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) { const k = FLAGS[argv[i]]; if (k) o[k] = argv[++i]; }
  if (o.watchPid !== undefined) o.watchPid = Number(o.watchPid) || 0;
  return o;
}

// Streams -> delivery. Everything external is injectable so tests need no hub and no agent.
export function createListener({ cfg, streams, deliver, log = () => {}, watchPid = 0, aliveImpl = alive,
  pollMs = 5000, open = openStreams, onExit = () => {} }) {
  let stopped = false, timer = null, handle = null;
  // One delivery at a time, in arrival order: two `codex queue` calls racing each other would
  // reorder a conversation.
  let chain = Promise.resolve();
  const stop = (why) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (handle) handle.stop();
    log(`stopping: ${why}`);
    onExit(why);
  };
  handle = open({ cfg, streams, log, onRow: (row, org) => {
    chain = chain.then(async () => {
      if (stopped) return;
      // The agent may have exited since the last poll; a pointer delivered now could be typed
      // into the shell it left behind.
      if (watchPid && !aliveImpl(watchPid)) return stop(`agent process ${watchPid} exited`);
      const id = `${org}/${row.channel}/${row.ts}`;                // ids only — never the body
      try { await deliver(row, org); log(`delivered ${id}`); }
      catch (e) {
        if (e instanceof SessionGone) stop('session is gone');
        else log(`delivery failed ${id}: ${String(e.message).slice(0, 200)}`);
      }
    });
  } });
  if (watchPid) timer = setInterval(() => { if (!aliveImpl(watchPid)) stop(`agent process ${watchPid} exited`); }, pollMs);
  return { stop, idle: () => chain, get stopped() { return stopped; } };
}

export async function main(argv = process.argv.slice(2), env = process.env, home = homedir()) {
  const a = parseArgs(argv);
  if (!a.agent || !a.session || !a.dir) {
    console.error('usage: listen.mjs --agent <codex|muse> --session <id> --dir <path> [--watch-pid <pid>] [--deliver native|tmux] [--tmux-pane <id>]');
    return 2;
  }
  const cfg = remoteConfig(env, { configPath: `${home}/.slackline/config.json` });
  if (!cfg) { console.error('slackline-listen: no hub configured (set SLACKLINE_REMOTE or ~/.slackline/config.json)'); return 1; }
  const streams = resolveRoute(a.dir, { file: env.SLACKLINE_ROUTES_FILE || `${home}/.slackline/routes.json` });
  if (!streams.length) return 0;                                  // nothing routed here: no listener at all

  const log = (m) => console.error(`[slackline-listen ${a.agent}] ${new Date().toISOString()} ${m}`);
  const runDir = `${home}/.slackline/run`;
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const pidFile = `${runDir}/${a.agent}-${a.session}.pid`;
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const cleanup = () => { try { if (readFileSync(pidFile, 'utf8') === String(process.pid)) rmSync(pidFile); } catch {} };

  let deliver;
  try { deliver = makeDelivery({ agent: a.agent, mode: a.deliver || 'native', session: a.session, pane: a.tmuxPane, cwd: a.dir, inboxDir: `${home}/.slackline/inbox`, env }); }
  catch (e) { log(e.message); cleanup(); return 1; }
  const listener = createListener({ cfg, streams, deliver, log, watchPid: a.watchPid || 0,
    onExit: () => { clearInbox(a.agent, a.session, `${home}/.slackline/inbox`); cleanup(); process.exit(0); } });
  process.once('SIGTERM', () => listener.stop('SIGTERM'));
  process.once('SIGINT', () => listener.stop('SIGINT'));
  log(`listening for ${streams.map(s => `${s.org}:${s.channels.join(',')}`).join(' ')} -> ${a.deliver || 'native'} (session ${a.session})`);
  return null;                                                    // open streams keep the process alive
}

const self = (() => { try { return pathToFileURL(resolvePath(process.argv[1] || '')).href; } catch { return ''; } })();
if (import.meta.url === self) { const code = await main(); if (code !== null) process.exit(code); }
