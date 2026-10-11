# Agent bridge

`bridge.mjs` relays messages from one Slack channel into an agent and acks them. Every mode
shares one core (`bridges/core.mjs`): channel filtering, dropping `origin=hub` (the agent's own
posts), skipping slash-command echoes Slack sometimes posts as ordinary messages, a durable
(file-backed) dedupe, the 👀 ack reaction, attachment download, the report-file writer, and a
startup backfill sweep for anything missed while the bridge was down. Only **delivery** — how
the agent is told a report landed — differs per mode.

Select a mode with `SLACKLINE_BRIDGE=channels|tmux|headless|auto` (default `channels`).

## Common env vars

| Var | Meaning |
|---|---|
| `SLACKLINE_APP_TOKEN` / `SLACKLINE_BOT_TOKEN` | app (bot) credentials — both required |
| `SLACKLINE_BRIDGE_CHANNEL` | channel id to watch (e.g. `C0EXAMPLE01`) |
| `SLACKLINE_BRIDGE` | `channels` \| `tmux` \| `headless` \| `auto` (default `channels`) |
| `SLACKLINE_QA_DIR` | where report files land (default `~/.slackline/qa`) |

## `tmux` — the established mode

Types a short pointer line into a tmux pane via `tmux send-keys`; the full report goes to a
file on disk (path in the pointer), because `send-keys` would otherwise have to escape every
quote/newline in a full report, and a multi-line paste into an agent's input box submits early.
Claude Code queues input while busy, so this never disrupts work in flight.

```
SLACKLINE_BRIDGE=tmux SLACKLINE_BRIDGE_TMUX=<session-name> node bridge.mjs
```

Fails fast at startup if the named session doesn't exist.

## `headless` — new

Spawns `claude -p '<pointer>'` per incoming message. No conversation continuity across
messages, but no TTY fragility and it parallelizes trivially. Concurrency is capped (default 2)
with a FIFO queue beyond the cap, so a burst of messages cannot fork unbounded processes.

```
SLACKLINE_BRIDGE=headless SLACKLINE_BRIDGE_CONCURRENCY=2 node bridge.mjs
```

## `channels` — new, favored, **untested**

Native Claude Code channel push. The server side already exists in `mcp.mjs`: when
`SLACKLINE_CHANNEL=1` it advertises `experimental: { 'claude/channel': {} }` and emits
`notifications/claude/channel` for every human/peer message straight over the agent's own MCP
stdio connection.

**bridge.mjs is a separate process with no MCP session, so it cannot emit that notification —
only the agent's own `mcp.mjs` connection can.** There is nothing left to relay: this mode in
`bridge.mjs` is advisory only. It probes whether the installed `claude` supports `--channels`
and prints the real launch command, then exits without starting a second, redundant Socket Mode
connection. The actual bridge for this mode is running `mcp.mjs` itself:

```
SLACKLINE_CHANNEL=1 SLACKLINE_APP_TOKEN=xapp-... SLACKLINE_BOT_TOKEN=xoxb-... \
  claude --channels server:slackline
```

(`server:slackline` assumes an MCP server named `slackline` pointing at `mcp.mjs` is already
registered — see the top-level README for adding an MCP server.)

**Status.** Push with the development flag (`--dangerously-load-development-channels`) was
observed to work: on Claude Code 2.1.241 a live Slack message reached a session and the agent read
its `origin=hub` metadata and declined to act, and
[docs/agents/claude-code.md](agents/claude-code.md) records the same flag on 2.1.295 with pushed
messages arriving as channel events. Plain `--channels` only works for plugins on Claude Code's
allowlist, which slackline is not on, so it starts normally and does not register the channel.
The probe logic (`bridges/channels.mjs:available()`) and the advisory `init()` are unit-tested;
this bridge's channels mode has not been run end to end.

## `auto`

Tries `channels`, falls back to `tmux`, falls back to `headless` — each `available()` check is
a real probe, not a guess:

- **channels**: spawns `claude --help` and checks the output for a `--channels` flag.
- **tmux**: requires `SLACKLINE_BRIDGE_TMUX` to name a session, and runs
  `tmux has-session -t <session>` against it.
- **headless**: checks `claude` resolves via `which claude` (i.e. is on `PATH`).

If none are available, `bridge.mjs` exits non-zero with a message naming what failed.

```
SLACKLINE_BRIDGE=auto node bridge.mjs
```

## Structure

```
bridges/core.mjs       shared core: ack/dedupe/backfill/report-writer, createBridge()
bridges/tmux.mjs       tmux send-keys delivery (the established mode)
bridges/headless.mjs   claude -p spawn delivery, concurrency-capped queue
bridges/channels.mjs   advisory-only: documents the mcp.mjs launch invocation
bridges/select.mjs     pure SLACKLINE_BRIDGE mode selection / auto-detection
bridge.mjs             entrypoint: parses env, selects a mode, wires the core to it
```

Each mode module exports `name`, `available()` (real, awaitable probe used by `auto`), and
`init({ channel, log })`, which either returns `{ deliver, label }` (a function that gets a
rendered pointer line delivered to the agent) or `{ skipIngest: true, label }` for the advisory
`channels` case.
