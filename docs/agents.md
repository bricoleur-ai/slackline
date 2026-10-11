# Agent push: slackline in every session on a machine

`slackline agents install` gives every Claude Code, Codex, OpenCode and Muse session started on
a machine the slackline tools, and pushes Slack messages into sessions through each agent's own
mechanism. Which channels a session hears is decided by the directory it was started in.

In these pages `slackline …` means `node <repo>/cli.mjs …` unless the `slackline` command is on
your PATH. Each page under `agents/` is a record of what was checked with that agent: which
version, what was seen, and what was not tried. All of those checks were run on one Linux
machine, called "the test machine" on those pages; the Muse and tmux-delivery checks ran inside
tmux there. Dates are the local date of the test machine (listener logs use UTC, so an evening
check can show the next day).

Push does not reach every session of every agent: a Codex session attached to Codex's shared
background server gets no push, and a Muse session gets push only inside tmux. See "Each agent"
and "What push does and does not do".

## Before you route a channel

**A routed channel can start agent turns.** A message posted there arrives in the session and
the agent responds, including in sessions running with permission prompts skipped. Anyone who
can post in that channel can put text in front of that agent. Route only channels whose members
you would let prompt it.

The adapters deliver provenance and content, never instructions, inside a
`<channel source="slackline" …>` tag. Claude Code shows a pushed message as a channel event. In
Codex and OpenCode it arrives as a user turn, so the tag is the only marker. In Muse (tmux
delivery) a one-line pointer, which holds no names, is pasted into the input box and the message
itself sits in a private file. How an agent should treat pushed messages is yours to state in its `AGENTS.md` /
`CLAUDE.md`.

## Set up a machine

You need a running hub and a scoped key for it ([keys.md](keys.md)).

**1. Machine config** — one file, mode 0600, holding the only copy of the key on the machine:

```bash
umask 077; mkdir -p ~/.slackline
cat > ~/.slackline/config.json <<'JSON'
{ "hub": "http://127.0.0.1:8790", "key": "slk_...", "org": "your-default-workspace" }
JSON
```

`org` is the workspace used for a tool call whose channel is not in the routing table.

Creating this file switches **every** `mcp.mjs` registration on the machine that sets no explicit
hub (`SLACKLINE_REMOTE`) to remote mode: from then on they talk to this hub instead of running a
local-mode server. That is how `remote.mjs` has always read it, not something the installer adds.

**2. Install**

```bash
node <repo>/cli.mjs agents install          # all of: shell claude opencode codex muse
node <repo>/cli.mjs agents status
```

It is safe to re-run. Every file it edits is first copied to `<file>.bak-slackline-<timestamp>`
(Codex's `config.toml` is copied before the installer runs `codex mcp add` / `remove`, because
Codex rewrites that file itself). `agents uninstall` removes what was added; for Muse it only
disables the plugin. The installer decides what is its own by parsed values, not by text. It
refuses, and changes nothing in that file, when a config is not plain JSON (or not valid UTF-8),
when it holds a `slackline` entry the installer did not write, when `~/.local/bin/csl` is a
symlink to something else, or when `~/.config/opencode/plugin/slackline.js` has other content.
It reports each step as it completes. `agents.env` is written mode 0600 and keeps any line you
add to it (below).

**Moving or deleting the checkout.** The registrations name this checkout's paths. Run
`agents uninstall` from the old checkout first, then install from the new one. If the checkout
was moved without that, `agents status` shows `tools: OTHER` (not `NO`) for each agent that has a
`slackline` entry which is not this checkout's, and one `note` line naming those agents; uninstall
from the old path, or remove the entry by hand.

**What `agents uninstall` leaves behind:** `~/.slackline/agents.env`; a `routes.json` the
installer created; a file the installer created that holds only `{}`; the
`<file>.bak-slackline-<timestamp>` backups; the Muse plugin (disabled, not removed); the original
`~/.local/bin/csl` if there was one (it stays in its backup, it is not restored); and any
running listeners. If listeners are running it prints one line naming them and the `kill <pid>`
that stops them; it does not kill them. For Muse it fails, and changes nothing, when
`muse plugins list` cannot be run or read, and fails when `muse plugins disable` fails.

**3. Route some channels** — edit `~/.slackline/routes.json` (see below), then open a new shell.

## The routing table

`~/.slackline/routes.json`:

```json
{
  "defaults": [
    { "org": "acme", "channels": ["D0EXAMPLE01"] }
  ],
  "routes": [
    { "dir": "/home/you/projects/example", "org": "acme", "channels": ["C0EXAMPLE02"] },
    { "dir": "/home/you/projects/example", "org": "Globex Corp", "channels": ["C0EXAMPLE04"] }
  ]
}
```

A session hears:

- every channel in `defaults`, whatever directory it is in; plus
- the channels of the **nearest mapped directory**: its own, or its closest mapped ancestor. A
  mapping on `/home/you/projects` covers every project under it until one of them has its own.

Notes:

- Every entry names its workspace (`org`), as `slackline agents status` lists them. A directory
  that listens in two workspaces has two entries.
- `dir` must be an absolute path.
- A directory with no mapping and no defaults gets the tools and no push.
- Default channels wake **every** running session on the machine at once. Keep them low-traffic.
- A typo in this file means "no routes", not an error. `slackline route [dir]` prints what a
  directory resolves to; check it after editing.
- Changes apply to sessions started afterwards.

## Each agent

| Agent | Tools | Push arrives as | Details |
|---|---|---|---|
| Claude Code | user-scope MCP server | a channel event, from the session's own MCP server; the launcher adds the flag | [agents/claude-code.md](agents/claude-code.md) |
| OpenCode | `mcp.slackline` in `opencode.json` | a prompt injected by an in-process plugin | [agents/opencode.md](agents/opencode.md) |
| Codex | registered with `codex mcp add` (stored in `config.toml`) | a queued message from a per-session listener — **sessions not on Codex's shared background server only** | [agents/codex.md](agents/codex.md) |
| Muse | `mcpServers.slackline` in `settings.json` | a typed pointer to a private file under `~/.slackline/inbox/` — **in tmux only** | [agents/muse.md](agents/muse.md) |

Read the page for an agent before relying on it. The thing to know for each:

- **Claude Code:** push needs a launch flag in every session. The `claude` shell function and
  `csl` add it; a session started another way (IDE, desktop app, `tmux new claude`) has the
  tools and no push. The development-channels confirmation appeared again on a repeat start in a
  directory that had been started in before; the folder-trust prompt did not (see the Claude Code
  page).
- **OpenCode:** what happens to a message that arrives while the session is busy is **not
  verified**.
- **Codex:** a normal `codex` can attach to a shared background server. A session there gets
  the tools and **no push**: no listener starts, and one line in
  `~/.slackline/logs/hook-codex.log` says so. This is deliberate: `codex queue` accepts a
  message for a closed session, so a listener that outlived its session would queue messages
  that replay on resume. Push works for a session running embedded (without the background
  server). Which one you get is Codex's choice. Codex also does not run the installed hooks until
  you have trusted them (a prompt, or `/hooks`).
- **Muse:** Muse 1.4.4 refuses a cross-session message sent from a shell
  (`unverified_target_receipt`), so push uses tmux delivery, and a Muse session outside tmux
  gets the tools and no push.

Codex and Muse listeners start at the session's **first prompt**, not when the agent opens.

### tmux delivery

Muse's default, and optional for Codex (`SLACKLINE_DELIVER_CODEX=tmux` in
`~/.slackline/agents.env`; not exercised with Codex). The listener writes each message to a
private file under `~/.slackline/inbox/` (it holds Slack content), pastes a one-line pointer
into the session's tmux pane, reads the pane back, and presses Enter only if the pointer's file
path is on screen. The pointer is exactly `New Slack message - external content, read it from
<path>`: it holds no sender or channel name (those are in the file).

- **The pane** is the one whose terminal is the session's own agent process's controlling
  terminal, so an agent running in an editor's terminal inside a tmux pane is not mistaken for
  the pane that holds the editor. It is never taken from `TMUX_PANE`. With no session-owned
  process to watch, or no pane, no listener starts and one line is logged.
- **Paste, then verify, then submit.** The pointer goes in as a tmux paste (a bracketed paste
  when the application asked for one), not as keystrokes. After a 500 ms pause the listener reads
  the last 40 lines of the pane (wrapped lines joined) and sends Enter only if the path is in
  them. If it is not, nothing more is sent, the listener logs `tmux delivery: the pane was not at
  an input prompt; message not submitted` with the message id, and the message is not retried.
  The inbox file stays until the listener stops. The check looks for the path as one unbroken
  string after both the pane text and the path are reduced to the characters `A-Za-z0-9._/-`, so
  line breaks, indentation and borders an application adds do not matter (Muse 1.4.4 breaks the
  pointer across two lines inside its input box).
- **A draft** being typed when a message arrives still gets the pointer appended, and the Enter
  then submits the whole input box (seen on Muse 1.4.4: the draft and pointer went in as one
  line).

A listener removes its session's inbox files when it stops.

## What push does and does not do

- **Live only.** A message that arrives while no session is listening is not replayed into the
  next one. The hub keeps recent history; an agent reads back with `slack_recent` or
  `slack_history`. Whether it should do that when it starts is your policy.
- **Codex and Muse start late.** Push into either begins at the session's first prompt; a
  message posted before that has nowhere to go and is not stored for later.
- **Not delivered at all:** a Codex session attached to the shared background server, and a
  Muse session outside tmux. Both get the tools and no push.
- **Plain messages.** Edits, deletions and reactions are not pushed. Attachments are named, not
  downloaded.
- **At most once.** A delivery that fails is logged and dropped, never retried.
- **Reconnects.** A dropped hub connection reconnects, and a channel-scoped stream asks the hub
  for messages since the last one seen (not verified live). After a long disconnect everything
  since the last message seen arrives at once: the hub replays up to 1000 stored messages per
  stream. A hub that is down when a session starts is retried until it answers, for Codex,
  OpenCode and Muse, and for Claude Code under routing (the default registration), whose tools
  stay up meanwhile (from the code; not seen live). A Claude Code registration with an explicit
  `SLACKLINE_CHANNEL_ONLY`, or with neither variable, still exits at start, so you see it.
- **A refused workspace is given up on.** If the hub answers 401 or 403 for one stream (a
  workspace name in `routes.json` that the hub does not serve, or a key without that scope), that
  stream is logged once and not retried; the other streams and the tools carry on.
- **No echo.** Agents on the machine post through the hub, and the hub does not push its own
  posts back.
- **Replies go to the right workspace.** The tools choose the workspace from the channel.
- **A listener belongs to one session.** It is tied to that session's own agent process and
  stops when the process goes, or on the session-end hook. If a running agent starts a new
  session without a session-end hook (`/new`, `/clear`, an in-app resume), the start hook stops
  the earlier session's listener for that same process first. A listener also checks that the
  process is still there before each delivery.
- **A pid file is only trusted if it is a listener.** A pid file counts only if that process's
  command line is `listen.mjs` for this session. Otherwise (a stale file whose number has been
  reused) it is ignored and removed, never signalled.

## Troubleshooting

Start with `slackline agents status`: it checks the hub and the key, shows what this directory
resolves to, and lists what is wired and which listeners are running. `push: yes` on an agent's
line means its push wiring is installed, not that a given session is receiving push; the `codex`
and `muse` lines also show `listeners: <n>`.

| Symptom | Look at |
|---|---|
| `hub FAILED — … 401` | the key in `~/.slackline/config.json` is wrong or revoked |
| `route      WARNING — routes.json names workspace "<name>", which the hub does not serve` | a misspelt workspace in `routes.json`: the hub refuses that stream (403). Claude Code's stderr or the listener log names the refused workspace; tools keep working, that stream gets no push. Fix the name |
| MCP server `slackline` fails to start in every session | `~/.slackline/config.json` is missing or unreadable (`SLACKLINE_REMOTE_ONLY` refuses to fall back to a local server) |
| tools work, nothing is pushed | `slackline route` in that directory; then that agent's page |
| tools work, a Codex or Muse session gets nothing | `~/.slackline/logs/hook-<agent>.log`: it records why no listener started (`no session-owned … process to watch`, or `not inside a tmux pane`). Also check the first prompt has been sent |
| `listen-muse-<session>.log` shows `delivery failed … unverified_target_receipt` | delivery mode is `native`, which Muse 1.4.4 refuses. Set `SLACKLINE_DELIVER_MUSE=tmux` in `~/.slackline/agents.env` (an `agents.env` that says `native` stays that way until you change it) and start a new session |
| Codex hooks installed but nothing runs | the hooks are not trusted yet: `/hooks` in a Codex session |
| a listener is `DEAD — stale pid file` | harmless; the next session with that id replaces it |
| `listen-<agent>-<session>.log` shows `the pane was not at an input prompt; message not submitted` | tmux delivery pasted the pointer but could not see it in the pane (a dialog or a menu); the message is in the inbox file, not submitted |
| a listener outlived its session | `kill <pid>` from `status`; see that agent's page |

Logs are in `~/.slackline/logs/`: `hook-<agent>.log` (why a hook declined to start a listener),
`listen-<agent>-<session>.log` (the listener's own), `opencode.log`. They hold ids and errors,
never message text or the key.

### Checking push without Slack

`test/live/fake-hub.mjs` is a stand-in hub (it checks no credentials; keep it on loopback). It
lets you prove a message reaches a real session without Slack or anyone to post. The recipe
passes `SLACKLINE_REMOTE` and `SLACKLINE_ROUTES_FILE` through the environment, so it works only
where the agent hands the session's environment to its MCP server or hook:

- **Claude Code** and **OpenCode**: yes.
- **Codex**: yes, when the session runs embedded (without the background server). On the
  background server the hook is run by the server, and the session gets no push anyway.
- **Muse**: **no.** Muse does not pass the caller's environment to hooks. Point Muse at a test
  hub by other means, or check with a real channel.

```bash
node <repo>/test/live/fake-hub.mjs --port 8799 &
mkdir -p /tmp/slk-check && cd /tmp/slk-check
echo '{ "defaults": [], "routes": [ { "dir": "/tmp/slk-check", "org": "testorg", "channels": ["CTEST"] } ] }' > routes.json
SLACKLINE_REMOTE=http://127.0.0.1:8799 SLACKLINE_ROUTES_FILE=$PWD/routes.json claude     # or opencode, codex
# in another terminal:
curl -s localhost:8799/subscribers
curl -s -XPOST localhost:8799/emit -d '{"org":"testorg","channel":"CTEST","text":"Reply with the single word PONG."}'
```

For Codex, send a first prompt before looking at `/subscribers`; the listener starts then.

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `SLACKLINE_ROUTES=1` | `mcp.mjs` (remote mode) | take push channels from the routing table |
| `SLACKLINE_REMOTE_ONLY=1` | `mcp.mjs` | exit rather than start a local-mode server when no hub is configured; set on every registration |
| `SLACKLINE_ROUTES_FILE` | everything | use this file instead of `~/.slackline/routes.json` |
| `SLACKLINE_SESSION_DIR` | `mcp.mjs`, hooks | treat this as the session's directory |
| `SLACKLINE_DELIVER_CODEX` | hooks, from `~/.slackline/agents.env` | `native` (default) or `tmux` |
| `SLACKLINE_DELIVER_MUSE` | hooks, from `~/.slackline/agents.env` | `tmux` (default; the installer writes it) or `native` (refused by Muse 1.4.4) |
| `SLACKLINE_HOOK_DEBUG=1` | hooks | save the raw hook input to `~/.slackline/logs/hook-<agent>-last.json`; for Muse, set it in `agents.env`, which keeps every line you add to it when the installer re-runs |
| `SLACKLINE_CHANNELS_APPROVED=1` | Claude launcher | use `--channels` instead of the development flag |

An explicit `SLACKLINE_CHANNEL_ONLY` on an MCP registration still wins over routing.
