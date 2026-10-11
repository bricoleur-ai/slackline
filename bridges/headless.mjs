// headless delivery: spawn `claude -p '<prompt>'` per incoming message. No conversation
// continuity (each spawn is a fresh, isolated agent turn), but no TTY fragility and trivially
// parallel — which is exactly why it needs a hard concurrency cap. A burst of Slack messages
// must not fork unbounded `claude -p` processes; excess deliveries queue FIFO and run as
// earlier ones finish.
//
//   SLACKLINE_BRIDGE_CONCURRENCY   max concurrent `claude -p` processes (default 2)
//   SLACKLINE_BRIDGE_CWD           working directory for spawned agents (default: inherit)
//
// SAFETY: a spawned `claude -p` acts in its working directory. Inheriting the bridge's cwd means
// running the bridge from inside a repo hands arbitrary Slack input write access to that repo.
// Set SLACKLINE_BRIDGE_CWD to the project the agent is SUPPOSED to work on, deliberately.
import { execFile } from 'node:child_process';

export const name = 'headless';
const DEFAULT_CONCURRENCY = 2;

// execImpl is injectable so tests can exercise the concurrency cap and the queue without
// spawning real processes (mirrors the WebSocketImpl injection pattern in transports/socket.mjs).
export function makeSpawner({ execImpl = execFile, concurrency = DEFAULT_CONCURRENCY, cwd, log = () => {} } = {}) {
  const cap = Math.max(1, concurrency);
  let active = 0;
  const queue = [];

  function pump() {
    while (active < cap && queue.length) {
      const { prompt, resolve, reject } = queue.shift();
      active++;
      execImpl('claude', ['-p', prompt], { maxBuffer: 10 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (err) => {
        active--;
        if (err) { log(`headless: claude -p failed: ${err.message}`); reject(err); }
        else resolve();
        pump();
      });
    }
  }

  function deliver(prompt) {
    return new Promise((resolve, reject) => { queue.push({ prompt, resolve, reject }); pump(); });
  }

  return { deliver, get active() { return active; }, get queued() { return queue.length; } };
}

// Real probe for auto-detection: is `claude` actually resolvable on PATH?
export async function available(execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl('which', ['claude'], (err) => resolve(!err));
  });
}

export function init({ log }) {
  const concurrency = Math.max(1, Number(process.env.SLACKLINE_BRIDGE_CONCURRENCY) || DEFAULT_CONCURRENCY);
  const cwd = process.env.SLACKLINE_BRIDGE_CWD || undefined;
  const spawner = makeSpawner({ concurrency, cwd, log });
  log(`headless delivery -> claude -p (concurrency ${concurrency}) in ${cwd || process.cwd() + ' [inherited]'}`);
  if (!cwd) log('WARNING: spawned agents act in the bridge\'s own cwd — set SLACKLINE_BRIDGE_CWD to target a project deliberately');
  return { label: `headless (concurrency ${concurrency})`, deliver: spawner.deliver };
}
