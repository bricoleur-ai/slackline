# slackline shell integration. Sourced from ~/.bashrc by `slackline agents install shell`.
# Two things, and nothing else:
#
#  1. Plain `claude` goes through the launcher, which adds the channels flag for interactive
#     sessions in directories that have something to push (scripts/claude-channels.sh).
#     A session started without an interactive bash (an IDE, `tmux new -s demo claude`) does
#     not see this function — use `csl` or the launcher's path there.
#
#  2. Muse keeps cross-session messaging, which is how slackline pushes into a Muse session,
#     behind two experimental switches. A Muse session only accepts pushed messages if both
#     are on in ITS environment, so they have to be exported before `muse` starts.
#
# This file is sourced into the operator's every interactive shell, so it must never break it:
# it does nothing outside bash, and the exports come first so they hold even if the function
# below cannot be defined.
[ -n "${BASH_VERSION:-}" ] || return 0
export MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING=on
export MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS=on
# builtin cd/pwd: an operator's own `cd` function that prints must not end up in the path.
SLACKLINE_REPO_DIR="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && builtin pwd)"
# An alias named claude would turn the definition below into a syntax error.
unalias claude 2>/dev/null
# The `function` form is not subject to alias expansion of its name. If the checkout has moved
# or been deleted since the shell started, fall back to the real claude rather than exit 127.
function claude {
  if [ -x "$SLACKLINE_REPO_DIR/scripts/claude-channels.sh" ] && [ -f "$SLACKLINE_REPO_DIR/scripts/claude-channels.sh" ]; then
    "$SLACKLINE_REPO_DIR/scripts/claude-channels.sh" "$@"
  else
    command claude "$@"
  fi
}
