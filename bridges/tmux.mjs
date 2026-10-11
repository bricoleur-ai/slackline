// tmux delivery: `tmux send-keys` a short pointer line into a session's pane. Claude Code
// queues input while busy, so this never disrupts work in flight. The full report goes to a
// file (bridges/core.mjs) and only a pointer is typed here, because send-keys would otherwise
// have to escape every quote/newline, and a multi-line paste into an agent's input box submits
// early. This is the established mode; keep its behavior exactly.
//
//   SLACKLINE_BRIDGE_TMUX   tmux session to inject into (e.g. demo)
import { execFileSync } from 'node:child_process';

export const name = 'tmux';

function hasSession(session) {
  try { execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Real probe for auto-detection: is there actually a live session to inject into?
export async function available() {
  const session = process.env.SLACKLINE_BRIDGE_TMUX;
  return !!session && hasSession(session);
}

// Fail fast on a missing session rather than silently dropping every report into the void.
export function init({ log }) {
  const session = process.env.SLACKLINE_BRIDGE_TMUX;
  if (!session) throw new Error('set SLACKLINE_BRIDGE_TMUX (tmux session name)');
  if (!hasSession(session)) throw new Error(`tmux session '${session}' not found — start it first`);
  log(`tmux delivery -> session '${session}'`);
  return {
    label: `tmux:${session}`,
    deliver(pointer) { inject(session, pointer); },
  };
}

function inject(session, line) {
  // -l sends the text literally so brackets/quotes aren't read as key names; Enter is separate.
  execFileSync('tmux', ['send-keys', '-t', session, '-l', line]);
  execFileSync('tmux', ['send-keys', '-t', session, 'Enter']);
}
