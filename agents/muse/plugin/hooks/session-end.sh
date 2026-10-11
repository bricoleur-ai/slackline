#!/bin/sh
# Muse SessionEnd hook: stop this session's slackline listener. See session-start.sh.
#
# Output is discarded and an EXIT trap forces status 0 before anything is sourced, so a
# malformed agents.env is a silent no-op here too. Stdin is left alone, it carries the hook's JSON.
exec >/dev/null 2>&1
trap 'exit 0' EXIT
[ -r "$HOME/.slackline/agents.env" ] || exit 0
set -a
. "$HOME/.slackline/agents.env"
set +a
[ -r "$SLACKLINE_REPO/agents/hook.sh" ] || exit 0
exec sh "$SLACKLINE_REPO/agents/hook.sh" end --agent muse
