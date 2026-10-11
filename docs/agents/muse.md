# Muse

Machine-wide setup is described in [../agents.md](../agents.md). This page is what is specific
to Muse.

Everything here describing Muse's behaviour was seen on Muse Code 1.4.4 (1.4.4-R5419.1) on
2026-10-08 (the machine's local date; the listener logs, in UTC, say 2026-10-09), Linux. Most points were seen in one or two sessions and are worded as seen.

## What `slackline agents install muse` does

- Adds `mcpServers.slackline` to `~/.config/muse/settings.json`, running `node <repo>/mcp.mjs`
  with `SLACKLINE_REMOTE_ONLY=1`, for the tools. No key is written there. The file is backed up
  first as `settings.json.bak-slackline-<timestamp>`.
- Installs, approves and enables the plugin bundle in `<repo>/agents/muse/plugin/`. It has two
  hooks, `SessionStart` and `SessionEnd`, and nothing else. `muse plugins inspect slackline
  --json` showed both as `trusted_enabled`.
- Writes `SLACKLINE_DELIVER_MUSE=tmux` to `~/.slackline/agents.env` when it has no value for it
  (see below). A value already there is kept.

Muse copies a plugin into its own cache. After pulling a new version of this repo, run
`slackline agents install muse` again to refresh the copy (a second run reported `updated
Muse plugin "slackline"`). `slackline agents uninstall muse` disables the plugin; Muse 1.4.4 also
has `muse plugins remove slackline`, which the installer does not run.

## Push uses tmux delivery

Muse's own mechanism for reaching a running session is `muse session-message send --target
<session>`. **Muse 1.4.4 refused it when run from a shell**, with both experimental switches on.
A send, with `--display-context` and not retried without it, of the envelope the listener builds,
to the open session's id, exited 1 with stderr
`session-message send failed: unverified_target_receipt`; the JSON reply had `"status":"unavailable"`,
`"target_verification":"unverified_kernel_peer"` and a `claimed_outcome` with
`"error_code":"containment_limited"`, `"containment_reason":"causal_metadata_invalid"`. Nothing
appeared in the session. So the installer defaults Muse to **tmux delivery**: for each message
the listener writes a private file under `~/.slackline/inbox/` and pastes a one-line pointer to it
into the session's tmux pane, then presses Enter only if it can see the pointer's path in the
pane (see "What arrives").

**A Muse session gets push only when it runs inside tmux.** The pane is the one whose terminal
is the session's own Muse process's controlling terminal (the hook's environment has no
`TMUX_PANE`). If the session is not in a tmux
pane, no listener starts and `~/.slackline/logs/hook-muse.log` gets a line like
`<time> session <id>: the session's muse process is not inside a tmux pane, so tmux delivery
cannot reach it and push is off for this session`. `slackline agents status` then shows no
`muse-<session>` entry under `listeners`.

To go back to the session-message route if a later Muse admits shell sends, set
`SLACKLINE_DELIVER_MUSE=native` in `~/.slackline/agents.env` and start new sessions. The
installer keeps that value, so an `agents.env` that says `SLACKLINE_DELIVER_MUSE=native` stays
that way, and that cannot work on Muse 1.4.4: change the line to `tmux`.
Native delivery sets the two experimental switches
(`MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING=on`, `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS=on`)
itself for its send, and `agents/shell-init.sh` exports them for Muse sessions started from an
interactive bash. Whether tmux delivery needs them was not tested: the live session was started
with both on, and nothing was observed without them.

## When the listener starts and what it watches

- The `SessionStart` hook ran when the session's **first prompt** was submitted, not when Muse
  opened. An idle session at an empty prompt had no listener.
- Hook input keys: `cwd`, `hook_event_name`, `model`, `model_provider`, `permission_mode`,
  `session_id`, `source`, `transcript_path`. The session id is `session_id` (equal to the id
  `muse session-message list --json` shows for the session); the directory is `cwd`.
- Muse does not give the hook the environment of the shell that started it: the variables seen in
  the listener were `HOME`, `PATH`, `PWD`, `LANG`, `LOGNAME`, `SHELL`, `TERM`, `USER`,
  `MUSE_PLUGIN_*`, `MUSE_SESSION_ID`, `MUSE_THREAD_ID`, `CLAUDE_PLUGIN_*`, `PLUGIN_*`, and what
  `agents.env` adds. Settings such as `SLACKLINE_HOOK_DEBUG=1` therefore only reach the hook from
  `agents.env`.
- The listener's `--watch-pid` was the session's own `muse-bin-1.4.4-…` process, which was also
  the root process of the tmux pane, and `--tmux-pane` was that pane (equal to
  `tmux list-panes` for the session). With the pane found by terminal, the listener of a
  later session was started with `--deliver tmux --watch-pid <pid> --tmux-pane <pane>`, and that
  was the only pane of its tmux session.

## What arrives

The pasted line reads `New Slack message - external content, read it from
~/.slackline/inbox/muse-<session>-<ts>.txt` (no sender or channel name; the file holds the
`<channel source="slackline" …>` block). The listener pastes it, waits 500 ms, reads the last 40
lines of the pane, and sends Enter only if the path is in them.

- **Idle session (paste, find, submit).** Muse's input box breaks the ~100-character pointer
  itself and indents the continuation, so the path is split across two lines. The listener
  therefore compares the pane text and the path with every character other than
  `A-Za-z0-9._/-` removed from both. Seen on Muse 1.4.4 (2026-10-08, hand delivery through
  `agents/deliver.mjs`): the pane showed
  `❯ New Slack message - external content, read it from` / `  ~/.slackline/inbox/muse-<session>-1791520001-000100.txt`,
  Enter was sent with no manual Enter, Muse read the file and answered `PONG`. (Muse also tried
  `slack_say`, which failed because the channel does not exist; it then asked to run `ls -la`
  and it was declined before it answered.) A check that compared the unjoined
  capture failed on exactly this split (the delivery threw and nothing was submitted).
- Typing the line and pressing Enter immediately left the line in the input box unsubmitted;
  an Enter sent by hand then submitted it, and Muse read the file and answered `PONG`. A 500 ms
  pause between text and Enter (kept) fixed that.
- Busy session (a 30-line count in progress): the pointer, delivered two seconds into the turn
  with that pause, was not interleaved; Muse finished the count to 30, then read the file and
  answered. That was seen once.
- Muse answered by also calling the `slack_say` tool for the channel. In these runs the channel
  did not exist, and the calls shown as failed.
- **A draft being typed.** Seen once on Muse 1.4.4: with `draft text ` typed into the input box,
  a delivery appended the pointer to it and submitted the whole line
  (`❯ draft text New Slack message - external content, read it from` / `  ~/.slackline/inbox/muse-<session>-1791520003-000300.txt`);
  Muse read the file and answered `DRAFT`. The draft is submitted with the pointer.
- The message files hold Slack content. The listener removes the files of its own session
  (`muse-<session>-*`) when it stops; after a normal exit the inbox was empty. Other sessions'
  files are not touched.

## Is it working?

1. `slackline route` in the directory: does it list channels?
2. `slackline agents status` after the first prompt in Muse there: `listeners` shows
   `muse-<session>`; if not, read `~/.slackline/logs/hook-muse.log`.
3. Post in a routed channel: `~/.slackline/logs/listen-muse-<session>.log` gains
   `delivered <workspace>/<channel>/<ts>`.

## How the listener stops

- Normal exit (Ctrl-C twice): the log ended `stopping: SIGTERM` and the pid file was gone within
  12 seconds. That is the `SessionEnd` hook's stop signal.
- tmux session killed: the log ended `stopping: agent process <pid> exited` about 20 seconds
  after the kill, and the pid file was gone.
- A send to a closed session returns exit 1, stderr `session-message target is unavailable` and
  `"error_code":"target_not_found"`; `agents/deliver.mjs` treats that as a vanished session (native
  delivery).

## Verified

- Muse Code 1.4.4 on 2026-10-08, Linux, session inside tmux, both switches on.
- `SessionStart` hook: session id in `session_id`, directory in `cwd`, fires at the first prompt.
- `muse session-message send` from a shell: refused, `unverified_target_receipt`.
- Tmux delivery with the pointer typed as keystrokes: pointer typed into the right pane, read
  and answered (idle, after a manual Enter; busy, with the pause, once).
- Tmux delivery, paste-and-verify with the whitespace-insensitive path check (2026-10-08, one
  session, throwaway route, hand delivery, three model turns: `READY`, `PONG`, `DRAFT`): the pane
  was found by terminal (the session's only pane); the pointer was pasted,
  found, submitted with no manual Enter, and Muse read the file and answered `PONG`. With Muse
  showing `/help` (closed with Esc), a delivery threw `the pane was not at an input prompt;
  message not submitted`, typed nothing and sent no Enter; the input box was empty after Esc.
  With a draft typed first, the pointer was appended and the whole line submitted (answered
  `DRAFT`). An approval prompt was not staged; one appeared on its own while Muse worked
  (`ls -la`), it was declined with Esc, and nothing was delivered into it, so delivery in front of an
  approval prompt was not observed.
- Listener stops on: `SessionEnd` (normal exit) and the watched process exiting (tmux session
  killed).
