# OpenCode

Machine-wide setup is described in [../agents.md](../agents.md). This page is what is specific
to OpenCode.

## What `slackline agents install opencode` does

- Adds `mcp.slackline` to `~/.config/opencode/opencode.json`: a local MCP server running
  `node <repo>/mcp.mjs`, for the tools. No key is written there. The file is backed up first as
  `opencode.json.bak-slackline-<timestamp>`.
- Writes `~/.config/opencode/plugin/slackline.js`, a one-line re-export of
  `<repo>/agents/opencode/plugin.mjs`.

`opencode.json` must be plain JSON. If yours has comments the installer refuses and leaves it
alone; add the `mcp.slackline` entry by hand from the example below.

```json
"mcp": { "slackline": { "type": "local", "command": ["node", "<repo>/mcp.mjs"],
                        "environment": { "SLACKLINE_REMOTE_ONLY": "1" }, "enabled": true } }
```

## How push arrives

OpenCode's native mechanism is a **plugin** with access to the running server. The plugin runs
inside the OpenCode process: it resolves the instance's directory against
`~/.slackline/routes.json`, holds the hub streams itself, and injects each message with
`session.promptAsync`. There is no separate listener process to start or stop.

The message arrives as a **user turn** whose whole text is a `<channel source="slackline" …>`
block. OpenCode has no separate "external event" form, so that tag is the only thing marking
the text as coming from Slack rather than from you.

Which session receives it. By design (pinned by unit tests; the live check saw one held message
reach the first session):

- the root session that most recently showed activity in this OpenCode instance;
- never a subagent session;
- if no session exists yet (a fresh start, before your first prompt), up to 50 messages are
  held and delivered to the first session you create.

What happens to a message that arrives while the session is busy was **not verified** on the
test machine: the local model server that OpenCode sends its turns to was down, so there was
no long turn to be busy in. Do not rely on either behaviour until it has been checked.

## Is it working?

1. `slackline route` in the directory: does it list channels?
2. `tail ~/.slackline/logs/opencode.log` after starting OpenCode there: a line
   `listening for <workspace>:<channels> in <dir>`.
3. Post in a routed channel: the log gains `delivered <workspace>/<channel>/<ts> to ses_…`.

`opencode --pure` starts without any plugins, and so without push.

## Verified

- OpenCode 1.18.18 on 2026-10-08, Linux.
- Global plugin directory: `~/.config/opencode/plugin/` (singular) loaded the plugin.
- Held-before-first-session delivery: confirmed. A message sent before any prompt produced no
  `delivered` line; after the first prompt the log showed `delivered testorg/CTEST/… to ses_…`
  and the `<channel source="slackline" …>` block appeared as a user message above the prompt.
- Busy session: not checked (see above).
- Model reply during the check: none, for the same reason; delivery was confirmed from the log and the conversation.
