#!/bin/sh
# Entry point for an agent's SessionStart / SessionEnd hook:
#
#   hook.sh start --agent codex      (the hook's JSON arrives on stdin)
#   hook.sh end   --agent muse
#
# A hook runs in whatever environment the agent has, where `node` may not be on PATH (nvm) and
# this repo may be anywhere. `slackline agents install` records both in ~/.slackline/agents.env.
#
# This must never fail or print: it runs inside the agent's startup, and an agent may add hook
# output to the session. Guaranteed here, whatever agents.env contains: stdout and stderr are
# discarded up front (stdin is left alone, it carries the hook's JSON), and an EXIT trap forces
# status 0 -- sourcing a malformed file makes dash exit 2 with a syntax error, which the trap
# turns back into a silent no-op. Missing pieces likewise mean a silent no-op.
exec >/dev/null 2>&1
trap 'exit 0' EXIT
[ -r "$HOME/.slackline/agents.env" ] || exit 0
set -a
. "$HOME/.slackline/agents.env"
set +a
[ -x "$SLACKLINE_NODE" ] && [ -r "$SLACKLINE_REPO/agents/hook.mjs" ] || exit 0
"$SLACKLINE_NODE" "$SLACKLINE_REPO/agents/hook.mjs" "$@"
exit 0
