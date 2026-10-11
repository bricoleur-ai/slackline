#!/usr/bin/env bash
# Launch Claude Code with slackline's channel push already enabled.
#
# WHY THIS EXISTS
# Channel push (real-time Slack messages injected into the session) only registers when the
# MCP server is named in --channels / --dangerously-load-development-channels for THAT session.
# There is no settings.json key and no environment variable for it: the flags are the only route, and the managed-settings keys (channelsEnabled,
# allowedChannelPlugins) only *permit* channels, they do not turn them on for a session. So the
# flag gets forgotten, the session starts, everything looks healthy, and no messages arrive.
#
# This wrapper removes the need to remember. It looks up the MCP servers configured for the
# current directory, picks the ones that will actually push here, and adds the flag for exactly
# those. Where nothing would push it adds nothing and execs plain claude, so it is safe to wrap
# unconditionally — `slackline agents install shell` does that through agents/shell-init.sh.
#
# A server "will push here" when it has SLACKLINE_CHANNEL=1 and either an explicit channel list
# or, for a routed server (SLACKLINE_ROUTES=1), a routing table that resolves this directory to
# at least one channel (agents/route.mjs).
#
# Override the detected list with SLACKLINE_CHANNEL_SERVERS="slackline other" if needed.
# Set SLACKLINE_CHANNELS_APPROVED=1 once the server is on your org's allowlist, to use the
# plain --channels flag instead of the development one (which shows a startup confirmation).
set -euo pipefail

CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude)}
[ -n "$CLAUDE_BIN" ] || { echo "claude not found on PATH" >&2; exit 127; }
# The installer records the node it used in ~/.slackline/agents.env. Read that one value (never
# source the file) so the launcher works from a shell whose PATH has no node.
NODE=node
if [ -r "${HOME:-/nonexistent}/.slackline/agents.env" ]; then
  n=$(sed -n 's/^SLACKLINE_NODE=//p' "$HOME/.slackline/agents.env" | tail -n 1)
  n=${n#\"}; n=${n%\"}; n=${n#\'}; n=${n%\'}
  if [ -n "$n" ] && [ -f "$n" ] && [ -x "$n" ]; then NODE=$n; fi
fi
REPO=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)

# Already asked for explicitly? Don't second-guess the caller.
for a in "$@"; do
  case "$a" in
    --channels|--channels=*|--dangerously-load-development-channels|--dangerously-load-development-channels=*) exec "$CLAUDE_BIN" "$@" ;;
  esac
done

# Push only means something in an interactive session. A subcommand or a print-mode run gets
# plain claude: there the flag is at best noise and at worst a confirmation prompt in a script.
# A quoted prompt as the first argument ("fix the build") is still an interactive session.
case "${1:-}" in
  agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|update|upgrade)
    exec "$CLAUDE_BIN" "$@" ;;
esac
for a in "$@"; do
  case "$a" in
    -p|--print|-h|--help|-v|--version) exec "$CLAUDE_BIN" "$@" ;;
  esac
done

servers=${SLACKLINE_CHANNEL_SERVERS:-}
if [ -z "$servers" ]; then
  servers=$(SLACKLINE_REPO_DIR="$REPO" "$NODE" -e '
    const fs = require("fs"), path = require("path"), cp = require("child_process");
    const cwd = process.cwd();
    const found = new Set();
    // Asked at most once: does the routing table resolve this directory to any channel?
    let routed;
    const routes = () => routed ??= cp.spawnSync(process.execPath,
      [path.join(process.env.SLACKLINE_REPO_DIR, "agents", "route.mjs"), "--quiet", cwd]).status === 0;
    // A server only pushes when SLACKLINE_CHANNEL=1; naming one that does not would just
    // register a channel that never fires. A routed server with nothing routed here is the
    // same case, and naming it would cost a startup confirmation for nothing.
    const scan = (m) => { for (const [name, cfg] of Object.entries(m || {})) {
      const e = (cfg && cfg.env) || {};
      if (e.SLACKLINE_CHANNEL !== "1") continue;
      if (e.SLACKLINE_ROUTES === "1" && !e.SLACKLINE_CHANNEL_ONLY && !routes()) continue;
      found.add(name);
    } };
    try { scan(JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).mcpServers); } catch {}
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".claude.json"), "utf8"));
      scan(j.mcpServers);
      scan(((j.projects || {})[cwd] || {}).mcpServers);
    } catch {}
    process.stdout.write([...found].join(" "));
  ' 2>/dev/null) || servers=""
fi

if [ -z "$servers" ]; then exec "$CLAUDE_BIN" "$@"; fi

flag=--dangerously-load-development-channels
[ "${SLACKLINE_CHANNELS_APPROVED:-0}" = "1" ] && flag=--channels

# One attached option per server (--flag=server:x). Claude Code declares both flags variadic, so
# the spaced form (--flag server:a "a prompt") would swallow the user's prompt as one more server.
entries=(); names=(); for s in $servers; do entries+=("$flag=server:$s"); names+=("server:$s"); done
echo "slackline: enabling channel push for ${names[*]}" >&2
exec "$CLAUDE_BIN" "${entries[@]}" "$@"
