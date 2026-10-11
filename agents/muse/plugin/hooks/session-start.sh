#!/bin/sh
# Muse SessionStart hook: start this session's slackline listener.
#
# Muse copies this bundle into its plugin cache on install, so this script cannot reach the
# slackline repo by a relative path. `slackline agents install` records where the repo is in
# ~/.slackline/agents.env. Missing pieces mean a silent no-op — never a failed session start.
#
# Output is discarded and an EXIT trap forces status 0 before anything is sourced: a malformed
# agents.env makes sh exit 2 with a syntax error, and a hook must print nothing and always exit 0.
# Stdin is left alone, it carries the hook's JSON.
exec >/dev/null 2>&1
trap 'exit 0' EXIT
[ -r "$HOME/.slackline/agents.env" ] || exit 0
set -a
. "$HOME/.slackline/agents.env"
set +a
[ -r "$SLACKLINE_REPO/agents/hook.sh" ] || exit 0
exec sh "$SLACKLINE_REPO/agents/hook.sh" start --agent muse
