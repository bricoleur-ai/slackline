// channels delivery: native Claude Code channel push.
//
// UNLIKE the other three modes, there is nothing for bridge.mjs to relay here. The push is
// already fully implemented server-side in mcp.mjs: it advertises
// `experimental: { 'claude/channel': {} }` and emits `notifications/claude/channel` for every
// non-reaction/edit/delete message when SLACKLINE_CHANNEL=1 — see mcp.mjs's `PUSH` branch.
// mcp.mjs runs as the agent's own MCP stdio server, holding its own Socket Mode ingest
// (startOrg) in-process. bridge.mjs is a SEPARATE process with no MCP session of its own, so
// it structurally cannot emit that notification — only the agent's own mcp.mjs connection can.
//
// So this mode is advisory only: it verifies the one real prerequisite (an installed Claude
// Code that understands `--channels`) and documents the exact launch command, rather than
// duplicating a Socket Mode connection mcp.mjs already owns. Running bridge.mjs with
// SLACKLINE_BRIDGE=channels therefore does not start its own ingest loop — see bridge.mjs,
// which checks `skipIngest` and exits after printing this guidance.
//
// Observed to work with the development flag: on Claude Code 2.1.241 a live Slack message
// reached a session started with --dangerously-load-development-channels, and the agent read
// the origin=hub metadata and declined to act (docs/agents/claude-code.md records the same
// flag on 2.1.295). Plain --channels is not expected to register the channel (see 2 below).
// This bridge's channels mode itself has not been run end to end.
//
// Two preview-era gotchas, both of which make this look unsupported:
//  1. Neither --channels nor --dangerously-load-development-channels appears in `claude --help`
//     while the feature is in preview. Probing help text reports a false negative.
//  2. --channels only accepts plugins on an Anthropic-maintained allowlist (or an org's
//     allowedChannelPlugins). `slackline` is not on it, so --channels starts Claude Code
//     normally and silently does NOT register the channel. Use the development flag.
import { execFile } from 'node:child_process';

export const name = 'channels';

// Real probe, not a guess. Help text alone is NOT sufficient: the flags are hidden while the
// feature is in preview, so a help-only check reports false and `auto` would skip a mode that
// actually works. Try help first (correct once the flag is documented), then fall back to
// scanning the resolved binary for the literal flag.
// execImpl is injectable for tests (mirrors the pattern in bridges/headless.mjs).
export async function available(execImpl = execFile) {
  const helpSaysYes = await new Promise((resolve) => {
    execImpl('claude', ['--help'], { timeout: 5000 }, (err, stdout = '', stderr = '') => {
      if (err) return resolve(false);
      resolve(/--channels\b/.test(String(stdout)) || /--channels\b/.test(String(stderr)));
    });
  });
  if (helpSaysYes) return true;

  // Preview fallback: grep the binary itself. -a treats it as text; the flag is a literal
  // string in the bundle. Bounded by a timeout so a huge binary cannot stall selection.
  return new Promise((resolve) => {
    execImpl('sh', ['-c', 'grep -ac -- "--dangerously-load-development-channels" "$(readlink -f "$(command -v claude)")" 2>/dev/null'],
      { timeout: 8000 }, (err, stdout = '') => resolve(!err && Number(String(stdout).trim()) > 0));
  });
}

export function init({ log }) {
  log('channels mode: nothing to relay here — mcp.mjs already pushes notifications/claude/channel.');
  log('Register slackline as an MCP server for the project, then launch the agent with it:');
  log('  claude mcp add slackline -e SLACKLINE_APP_TOKEN=... -e SLACKLINE_BOT_TOKEN=... \\');
  log('    -e SLACKLINE_CHANNEL=1 -e SLACKLINE_CHANNEL_ONLY=<channel-id> \\');
  log('    -e SLACKLINE_STORE=sqlite:<path> -- node <repo>/mcp.mjs');
  log('  claude --dangerously-load-development-channels server:slackline');
  log('NOTE: use the development flag. Plain --channels only accepts an Anthropic-allowlisted');
  log('plugin, and slackline is not on it — Claude Code starts fine and the channel never registers.');
  return { label: 'channels (advisory only — see mcp.mjs)', skipIngest: true };
}
