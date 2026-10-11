# Claude Code

Machine-wide setup is described in [../agents.md](../agents.md). This page is what is specific
to Claude Code.

## What `slackline agents install shell claude` does

- Registers one **user-scope** MCP server named `slackline`: `node <repo>/mcp.mjs` with
  `SLACKLINE_CHANNEL=1`, `SLACKLINE_ROUTES=1` and `SLACKLINE_REMOTE_ONLY=1`. The hub URL and key
  are not in the registration; `mcp.mjs` reads them from `~/.slackline/config.json`.
- Adds a block to `~/.bashrc` that sources `agents/shell-init.sh`, which defines a `claude`
  shell function. Plain `claude` then goes through `scripts/claude-channels.sh`.
- Links `~/.local/bin/csl` to `scripts/csl`.

## How push arrives

Claude Code has a native mechanism for this: an MCP server can push **channel events** into a
running session. `mcp.mjs` resolves the session's directory against `~/.slackline/routes.json`,
opens one hub stream per workspace, and emits each message as a
`<channel source="slackline" …>` event. The session reacts without being prompted.

Channels only register when the server is named in a launch flag, every session. There is no
settings key for it. The launcher adds the flag for you, in attached form (one
`--dangerously-load-development-channels=server:slackline` per server, or `--channels=server:…`),
because Claude Code declares the option variadic: with a space between flag and value, a prompt
given as an argument (`claude "fix the build"`) would be taken as one more server name. The
prompt stays a separate argument after the flag. The launcher also does nothing to a command
line that already has `--channels` or `--dangerously-load-development-channels`, in either
spelling. It adds the flag only where it would do something:

| You run | Flag added? |
|---|---|
| `claude` / `csl` in a directory that resolves to at least one channel | yes |
| the same in a directory with nothing routed and no defaults | no |
| `claude -p …`, `claude mcp …`, `claude update`, any other subcommand | no |

While slackline is not on an Anthropic or organisation allowlist the flag is
`--dangerously-load-development-channels`, and Claude Code asks you to confirm it. It asked
again on a repeat start in a directory that had already been started in (see Verified), so
expect it at each start. Once it is allowlisted, set `SLACKLINE_CHANNELS_APPROVED=1` to use plain `--channels`.

The confirmation lists `1. I am using this for local development` and `2. Exit`. Option 1 is
pre-selected, so pressing Enter continues. Option 2 is `Exit`.

On the first start in each of two directories (and not on the repeat start described under
Verified), Claude Code showed a "Quick safety check: Is
this a project you created or one you trust?" prompt with the options `No, exit` and
`Yes, I trust this folder`. Here the pre-selected option is **`No, exit`**: press Down to move to
`Yes, I trust this folder`, then Enter.

(Both prompts observed on Claude Code 2.1.295; wording and defaults may change between versions.)

## Sessions the `claude` function does not reach

A shell function exists only in an interactive bash. A session started from an IDE, the desktop
app, or as a tmux command (`tmux new -s demo claude`) does not go through it: the tools work,
push does not. Start those with `csl`, or with `<repo>/scripts/claude-channels.sh`, both of
which are ordinary executables.

## A directory with its own `slackline` server

A project-scope or directory-scope server named `slackline` overrides the user-scope one. That
is how a directory keeps an explicit `SLACKLINE_CHANNEL_ONLY` list; such registrations behave
exactly as they did before machine-wide routing existed.

## Is it working?

1. `slackline route` in the directory: does it list channels?
2. Start `claude` there: the launcher prints `slackline: enabling channel push for server:slackline`.
3. `/mcp` in the session: `slackline` is connected.
4. Post in a routed channel; the event appears within a few seconds.

If the session is silent, see "If push is silent" in the README: Claude Code skips channel
registration for several reasons and logs a reason rather than an error.

## Verified

- Claude Code 2.1.295 on 2026-10-08, Linux.
- MCP servers are started in the session directory: yes (the `mcp.mjs` process's working directory was the session directory), so the launcher does not need to export `SLACKLINE_SESSION_DIR`.
- Claude Code passes its environment to MCP servers: yes (`SLACKLINE_REMOTE` and `SLACKLINE_ROUTES_FILE` set in the launching environment reached `mcp.mjs`).
- A message emitted through `test/live/fake-hub.mjs` appeared as a channel event and was answered unprompted (the session answered PONG and replied in-thread through the slackline tool).
- Repeat start, after the launcher began passing the flag attached
  (Claude Code 2.1.295, 2026-10-08), in a directory that had been started in once before, with a
  prompt as the argument (`claude-channels.sh "Reply with the single word READY."`): the
  development-channels confirmation appeared again (option 1 pre-selected, Enter); the folder-trust
  prompt did not. The session received the prompt as its first message and answered `READY`, so
  the flag did not swallow it. The hub showed one subscriber (`testorg`, `CTEST`), a message
  emitted through the fake hub 25 seconds later was answered unprompted, and after the tmux
  session was killed the subscriber list was empty within four seconds with no `mcp.mjs` left
  from that session.
- A session in an unrouted directory got tools (`/mcp` showed `slackline` connected, 8 tools), no flag and no development-channels prompt, and the hub's subscriber count did not change (still the one routed session).
