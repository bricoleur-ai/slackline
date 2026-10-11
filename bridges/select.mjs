// Pure mode-selection logic, kept separate from bridge.mjs's process-level side effects
// (env reads aside) so it's directly unit-testable.
//
// An explicit mode must exist in the registry. 'auto' probes REAL conditions in priority
// order — channels, then tmux, then headless — never a guess: each mode's available()
// actually checks (installed claude supports --channels; the target tmux session exists;
// claude is on PATH), see bridges/channels.mjs, tmux.mjs, headless.mjs.
export async function selectMode(requested, modes, log = () => {}) {
  const key = String(requested || 'channels').toLowerCase();
  if (key !== 'auto') {
    const m = modes[key];
    if (!m) throw new Error(`unknown SLACKLINE_BRIDGE mode '${key}' (want channels|tmux|headless|auto)`);
    return m;
  }
  for (const name of ['channels', 'tmux', 'headless']) {
    const m = modes[name];
    if (m && await m.available().catch(() => false)) { log(`auto: selected '${name}'`); return m; }
  }
  throw new Error('auto: no delivery mode available (channels unsupported by installed claude, no tmux session, claude not on PATH)');
}
