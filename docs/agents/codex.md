# Codex

Machine-wide setup is described in [../agents.md](../agents.md). This page is what is specific
to Codex.

Everything on this page that describes Codex's behaviour was seen on Codex CLI 0.160.1 with a
shared background server running release 0.162.0, on 2026-10-08, Linux. Each observation says
which of Codex's two modes it was seen in; see "Two ways Codex runs a session".

## What `slackline agents install codex` does

- Registers the tools server with Codex's own CLI:
  `codex mcp add slackline --env SLACKLINE_REMOTE_ONLY=1 -- <node> <repo>/mcp.mjs`. No key is
  written. Codex stores the entry in `~/.codex/config.toml` and rewrites that file itself, so the
  installer never edits the entry there. It reads what is registered with
  `codex mcp list --json` first, and:
  - a `slackline` entry that runs exactly `<repo>/mcp.mjs` and sets no environment other than
    `SLACKLINE_REMOTE_ONLY` is the installer's: left alone if it is already right, otherwise
    removed and added again;
  - any other entry named `slackline` is yours: the install refuses and changes nothing.
- Adds `SessionStart` and `SessionEnd` hooks to `~/.codex/hooks.json` that run
  `<repo>/agents/hook.sh`.

If the `codex` command cannot be run, or what `codex mcp list --json` prints is not the JSON list
it expects, nothing of Codex's is written (`~/.slackline/agents.env` and `routes.json` are still
created, as for every target). `slackline agents uninstall codex` stops in the same way, before
it edits any file, and leaves the registration where it is. Before the first `codex mcp add` or
`codex mcp remove` of a run, the installer copies `~/.codex/config.toml` to
`config.toml.bak-slackline-<timestamp>`, because Codex rewrites that file; nothing is copied when
the registration is already right. A registration that passes environment through `env_vars` is
not the installer's either.

The installer never keeps the entry as a block in `config.toml` between the comment lines
`# >>> slackline >>>` and `# <<< slackline <<<`, because such a block does not survive Codex: on a
copy of a config, `codex mcp add` removed the opening line, moved the table, and left the closing
line on its own at the end of the file. If it finds such a block, with both lines there and
nothing but the installer's own lines between them, it removes it (the file is backed up first as
`config.toml.bak-slackline-<timestamp>`) and registers through the CLI instead. If only one of
the two lines is left, or anything else sits between them, it refuses and tells you what to
delete by hand.

### Trusting the hooks

Codex does not run a new or changed hook until you have reviewed and trusted it. The
first session started after the install was an embedded one (see below) and showed no such
prompt; `/hooks` there listed both hooks as needing review. The prompt came in the first
background-server session and it read:

```
Hooks need review
2 hooks are new or changed.
Hooks can run outside the sandbox after you trust them.
1. Review hooks
2. Trust all and continue
3. Continue without trusting (hooks won't run)
```

`Review hooks` lists them by event; each shows its source (`~/.codex/hooks.json`) and its
command, and `t` trusts it. Codex records the decision in `config.toml` under `[hooks.state]`.
The same list is at `/hooks` in any session. Until both hooks are trusted they do not run, so
there is no push; the tools registration does not depend on them.

## Two ways Codex runs a session

- **On the shared background server** (Codex's app-server daemon). The terminal is a client; the
  server runs the session, its MCP servers and its hooks, for every session attached to it.
- **Embedded**, inside the terminal's own `codex` process. Codex calls this running "without
  the shared background server".

Which one you get is Codex's choice, and on the test machine it was not the same from one start to
the next:

- `codex --dangerously-bypass-hook-trust` ran embedded. That flag was used for the embedded check
  only; it lets hooks run without review and is not something to set up for everyday use. Codex said: `Running without the shared
  background server: --dangerously-bypass-hook-trust requires embedded mode.`
- `codex --enable api_key_model_discovery` attached to the background server (seen twice).
- Plain `codex` did neither. It stopped at this prompt, because the CLI and the background
  server (which updates itself separately) disagreed about a feature setting:

  ```
  Background server has incompatible feature settings
  This session requires api_key_model_discovery to be disabled
  …
  1. Run without daemon this time
  2. Restart with these settings
  3. Cancel
  ```

  No option was chosen in the check. If `Run without daemon this time` runs the session the way
  the first bullet did, push works there as described for embedded mode below; that was not
  tried.

**In either delivery mode, push reaches only embedded sessions.** The next two sections say why.

## How push arrives

Codex's native mechanism is its **message queue**: `codex queue --thread <session> --message …`
adds a message to an existing session. The `SessionStart` hook starts a small listener
(`agents/listen.mjs`) beside the session. The listener resolves the session's directory against
`~/.slackline/routes.json`, holds the hub streams, and queues each message onto that session.

**In embedded mode the listener starts with your first prompt, not when Codex opens.** Codex ran
the `SessionStart` hook when the first prompt was submitted and not before: about a quarter of a
second after the prompt, in a session that had been open for three minutes.
A session that is open but has not yet been given a prompt has no listener, so a message posted
then has nowhere to go. Nothing is stored for later. On the background server the listener was
there after the first prompt; whether the hook had run earlier was not recorded.

The message arrives as a **queued user turn** whose whole text is a
`<channel source="slackline" …>` block (seen in both modes; on the background server the message was
queued by hand). Codex shows it exactly as it shows a prompt
you typed. `codex queue` has no option to label a message as external, so that tag is the only
thing marking the text as coming from Slack rather than from you.

How quickly a queued message is taken up, each seen once:

- embedded, session busy: a message queued half a second into a four-second turn waited, was
  taken up as that turn ended, and was answered as a turn of its own;
- embedded, session idle: taken up about 8 seconds after it was queued;
- background server, session idle: taken up at once.

The listener writes ids, never message text, to `~/.slackline/logs/listen-codex-<session>.log`.

## Push needs a `codex` process of the session's own

**`codex queue` accepts a message for a closed session.** One `codex queue` to a session that
had exited returned exit 0 and printed the same `Queued message <id> for thread <id>.` line as
for an open one; two minutes later the message was still waiting in the queue and nothing had
run. So a listener cannot learn from a delivery that its session has ended. Something else has
to stop it.

In embedded mode that something exists. The hook is run by the session's own `codex` process,
the listener watches that process, and `SessionEnd` ran on exit (see the next section).

On the background server it does not:

- the hook was run by the server itself, so the nearest `codex` process above the hook was the
  server. Above that came the server's updater, and above that the terminal of a different,
  unrelated session;
- a listener started there with the server as its watched process outlives the session, because
  the server does not exit when a session does;
- such a listener was still running 15 seconds after the session was ended with Ctrl-C, and, in a
  second session, 20 seconds after the terminal was closed. `SessionEnd` had not stopped it in
  either case. Both listeners had to be killed by hand.

So the hook starts a Codex listener, in either delivery mode, **only when it finds a `codex`
process that belongs to the session**. A process whose first argument is `app-server` (the server
and its updater) does not count, and nothing above one is looked at; a session started as
`codex "fix the app-server"` is still a session. When there is none:

- no listener is started, so `slackline agents status` shows no `codex-<session>` entry;
- one line is added to `~/.slackline/logs/hook-codex.log`:
  `<time> session <id>: no session-owned codex process to watch, so push is off for this session`.

The same applies to a Muse listener on tmux delivery (its log is `hook-muse.log`); Muse on native
delivery still starts without one. The rule is covered by the tests, and was watched once in a
live session on the background server: see "Verified".

## When the session ends

- **Embedded, ended with Ctrl-C at the idle prompt**: the listener logged `stopping: SIGTERM`,
  the signal the `SessionEnd` hook sends, 0.2 seconds after the first Ctrl-C; its pid file and
  its hub subscription were gone. The listener was also watching the session's own `codex`
  process as a second way out; that is not what stopped it here.
- **Embedded, terminal closed without exiting Codex**: not checked.
- **Background server**, either way: `SessionEnd` was not seen, as described above. No listener
  is started there.

## Is it working?

1. `slackline route` in the directory: does it list channels?
2. `/hooks` in the Codex session: `SessionStart` and `SessionEnd` each show 1 under Installed
   and 1 under Active. A 1 under Review means that hook is still waiting for you to trust it.
3. After your first prompt there, `~/.slackline/run/` holds `codex-<session id>.pid`, and
   `slackline agents status` names it on its `listeners` line and counts it at the end of its
   `codex` line (`listeners: 1`; that count was seen on the background server, where a listener had been
   started for the server's process). Note that `push: yes` on the `codex` line of `slackline agents status` means "the
   hooks are installed", not "this session is receiving push".
4. If it does not, read `~/.slackline/logs/hook-codex.log`: a line for your session means the
   hook found no `codex` process of the session's own, which is the case on the background
   server.
5. Post in a routed channel: the listener log gains `delivered <workspace>/<channel>/<ts>`.

To see exactly what Codex passed the hook, set `SLACKLINE_HOOK_DEBUG=1` and read
`~/.slackline/logs/hook-codex-last.json` after your first prompt. In the embedded run it was set
in the environment the test session was started with; in the background-server runs it was a
line in `~/.slackline/agents.env`, and the file was written.

## The tmux fallback

Set `SLACKLINE_DELIVER_CODEX=tmux` in `~/.slackline/agents.env` to have the listener write each
message to a private file under `~/.slackline/inbox/` and paste a one-line pointer (no names in
it) into the session's tmux pane instead, pressing Enter only once the pointer's path is seen in
the pane (see [../agents.md](../agents.md) and [muse.md](muse.md), where it was seen working). It was **not exercised** with Codex here.

The pane is derived from the session's own process: the pane whose terminal is that process's
controlling terminal (see [muse.md](muse.md) and [../agents.md](../agents.md)). It is never taken from
`TMUX_PANE`, because in the one background-server session where that was looked at, the
`TMUX_PANE` in the hook's environment named a pane in a different tmux session. So the hook starts
no tmux listener unless it can watch a `codex` process of the session's own:
on the background server no listener starts in either delivery mode, and the log line above is
written. With the hook run by the session itself (embedded) the tmux route is as untried as above.

## Verified

Seen in embedded mode (one session, started with `--dangerously-bypass-hook-trust`):

- `SessionStart` ran at the first prompt, not at start-up.
- `SessionStart` hook input fields: session id in `session_id`, directory in `cwd`. Also
  present: `transcript_path`, `hook_event_name`, `model`, `permission_mode`, `source`
  (`startup`).
- `codex queue --thread` reaches an open terminal session: yes. Two messages pushed through a
  test hub each appeared as a `<channel source="slackline" …>` user message and were answered,
  with nothing typed into the session.
- Busy session: the message waited for the running turn to finish and was then handled as the
  next turn.
- The listener's `--watch-pid` was the session's own `codex` process.
- Listener stops on: `SessionEnd`, when the session was ended with Ctrl-C at the idle prompt.
- A closed session: `codex queue` returned exit 0 and the message stayed queued.

Seen on the background server (one session, started with `--enable
api_key_model_discovery`, delivery `native`, a route to a channel that matches nothing, one
prompt `Reply with the single word READY.`, which was answered):

- No `codex-*.pid` in `~/.slackline/run/`, no `agents/listen.mjs` process, no new
  `listen-codex-*.log`, and `slackline agents status` showed `listeners: 0` on the `codex` line and
  `listeners  none running`.
- `~/.slackline/logs/hook-codex.log` held exactly one line, naming the session's id: `no
  session-owned codex process to watch, so push is off for this session`.
- That the session ran on the server rests on the same signs as the other background-server runs (two start-up
  warnings, not four) and on the log line itself; the server's own log was not read this time.

Seen on the background server in two sessions in which the hook was run by the server and the
listener was given the server's process to watch (started with `--enable api_key_model_discovery`):

- The hook-trust prompt at start-up, and the two hooks trusted through it.
- After the first prompt the hook had run, with the same input fields as above (whether it ran
  before the prompt was not recorded).
- The hook was run by the server process. Its `PATH` found `codex`; its `TMUX_PANE` (which is why
  the pane is never taken from it) was another tmux session's.
- `codex queue --thread`, run by hand, reaches an open terminal session: yes. One message
  appeared as a `<channel source="slackline" …>` user message and was answered, with nothing
  typed into the session.
- The listener's `--watch-pid` was the server, and the listener outlived the session after
  Ctrl-C and after the terminal was closed.

Seen without a session:

- The install replaced a marker block in `config.toml` with a registration made through
  `codex mcp add`, and a second run reported everything `unchanged`.
- `codex mcp add`, run on a copy of a config that held such a block, removed the block's
  opening line and kept its closing one.

Not verified:

- The tmux delivery mode on the background server (the rule is in the
  tests; the live check used native delivery).
- A message delivered by a listener, rather than queued by hand, to a session on the background
  server.
- Choosing `Run without daemon this time` at the feature-settings prompt.
- What happens to the listener when an embedded session's terminal is closed without exiting.
- Whether `SessionEnd` runs later for a session left on the background server.
- What happens to messages left in a closed session's queue when that session is resumed.
- A tool call through the registered server.
- The tmux fallback.
