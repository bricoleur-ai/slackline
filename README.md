# slackline

**Live Slack context for your coding agents: they read the room, reply, and hear new messages as they arrive.**

<!-- bricoleur:intro -->
> Part of **[bricoleur.ai](https://bricoleur.ai)**: small, honest tools cobbled together from the AI-era parts at hand. Related: **[2fu](https://github.com/bricoleur-ai/2fu)**, another small always-on service your agents call on the local network.
<!-- /bricoleur:intro -->

```mermaid
flowchart LR
    S[Slack workspace] -->|one live connection| H[slackline<br/>rolling store]
    A[Claude Code · Codex<br/>OpenCode · Muse] -->|tools: read, search, reply, react| H
    H -.->|new messages, routed by directory| A
```

## What it does

- Holds one live connection to Slack (your session token or a Slack app) and keeps a rolling
  store of recent messages, with names resolved, threads hydrated on demand and attachments archived.
- Gives any MCP agent eight tools to read context, backfill history, search, reply and react (ten
  when it runs in its own process, which adds two for app credentials): in that process on your
  laptop, or through a shared hub so agents never hold Slack credentials.
- Pushes new messages into running Claude Code, Codex, OpenCode and Muse sessions as they arrive,
  routed by the directory each session started in.

## Quick start

You need Node 22.13 or newer.

```bash
git clone https://github.com/bricoleur-ai/slackline ~/slackline
cd ~/slackline && npm install
```

### See it work, without Slack

A stand-in hub ships with the tests. It answers like a hub, on loopback only, with no Slack and no
credentials:

```bash
node ~/slackline/test/live/fake-hub.mjs --port 8799 &
claude mcp add slackline-try \
  -e SLACKLINE_REMOTE=http://127.0.0.1:8799 \
  -e SLACKLINE_ORG=testorg \
  -- node ~/slackline/mcp.mjs
```

Here `claude` is the Claude Code command-line tool; other agents get their tools through
[the install path below](#every-agent-on-this-machine-with-push). Start your agent and ask it to run `slack_whoami`. It worked if the answer is
`remote client attached to slackline hub at http://127.0.0.1:8799 (identity is the hub's, not this process's) — orgs_live: testorg`.
When you are done, run `claude mcp remove slackline-try` from the directory where you ran the
`add`, then `kill %1` in the terminal that started the hub.

## Connect your Slack

Pick the path that matches what you want. Each one ends with a check.

### One agent, no server

The agent runs slackline in its own process. There are no ports, no Postgres and no Docker. First
get a credential (see [Getting a credential](#getting-a-credential)); the collector opens a
browser, you sign in once, and it writes a file:

```bash
cd ~/slackline/packages/src && ./collect.sh --out ~/.slackline-tokens.json
```

Then register slackline with your agent:

```bash
claude mcp add slackline \
  -e SLACKLINE_TOKENS_FILE=$HOME/.slackline-tokens.json \
  -e SLACKLINE_STORE=sqlite \
  -- node ~/slackline/mcp.mjs
```

It worked if `slack_whoami` names your Slack account.

### A hub for many agents

One always-on host holds the Slack connection, and every agent talks to it over HTTP. No clone is
needed on the host; the compose file pulls a published image:

```bash
mkdir -p ~/srv/slackline && cd ~/srv/slackline
curl -fsSLO https://raw.githubusercontent.com/bricoleur-ai/slackline/main/docker-compose.yml
printf 'SLACKLINE_SECRET=%s\nPGPASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 16)" > .env
chmod 600 .env
docker compose up -d
```

Open `http://<host>:8790/`. The install page walks you through handing the hub a Slack
credential. From another machine `/health` needs the secret, so check it from the directory that
holds the `.env` you just wrote:

```bash
curl -s -H "x-slackline-secret: $(sed -n 's/^SLACKLINE_SECRET=//p' .env)" http://<host>:8790/health
```

It worked if the answer contains `"ok": true` and, once you have added a credential, your
workspace in `orgs_live`. The full runbook, image tags and CI publishing are in
[`docs/deploy.md`](docs/deploy.md).

### This agent, an existing hub

Remote mode sends every tool call to the hub. There is no local Slack connection and no local
database. Use a scoped key ([`docs/keys.md`](docs/keys.md)):

```bash
claude mcp add slackline \
  -e SLACKLINE_REMOTE=http://hub.example.com:8790 \
  -e SLACKLINE_KEY=slk_... \
  -e SLACKLINE_ORG=acme \
  -- node ~/slackline/mcp.mjs
```

Or write the hub and key once, so that every agent on the machine inherits them:

```bash
umask 077; mkdir -p ~/.slackline
cat > ~/.slackline/config.json <<'JSON'
{ "hub": "http://hub.example.com:8790", "key": "slk_...", "org": "acme" }
JSON
```

Environment variables win over the file, field by field. It worked if `slack_whoami` answers with
`remote client attached to slackline hub at http://hub.example.com:8790 …`.

> **Do not give a consumer the hub's Slack credentials.** Handing it `SLACKLINE_APP_TOKEN` plus a
> `DATABASE_URL` looks equivalent and silently loses messages, because Slack load-balances events
> across every open connection for an app. See
> [one connection per app](docs/deploy.md#one-slack-connection-per-app--consumers-must-use-remote-mode).

### Every agent on this machine, with push

**A routed channel can start agent turns.** A message posted there arrives in the session and the
agent responds. Route only channels whose members you would let prompt it; read
[`docs/agents.md`](docs/agents.md) before you route anything.

You need three things first:

1. A running hub (see above).
2. `~/.slackline/config.json`, mode 0600, with the hub's URL and a scoped key (the file from
   "This agent, an existing hub"). Creating it switches **every** `mcp.mjs` registration on the
   machine that does not pin its own hub to remote mode, including one you made in "One agent,
   no server".
3. A routing table, `~/.slackline/routes.json`, saying which channels each directory hears. Start
   from [`agents/routes.example.json`](agents/routes.example.json).

Then install:

```bash
node ~/slackline/cli.mjs agents install
node ~/slackline/cli.mjs agents status
```

`install` edits your shell rc file (`~/.bashrc`) and each agent's configuration, and writes
`~/.slackline/agents.env`. It copies every file it edits to `<file>.bak-slackline-<timestamp>`
first, and `agents uninstall` reverses it. It worked if `agents status` lists each agent you
have installed, and a message in a channel you routed shows up in a new session started in that
directory.

## How it works

On a hub, the `ingest` service holds the Slack socket and stays up across `api` redeploys. The
`api` service serves the routes and is woken by Postgres `NOTIFY`; a reconnecting client that filters
by channel passes `?since=` and the hub replays what it stored in the gap. On a laptop it is one process with
SQLite or memory. The hub marks your own posts `origin=hub`; see
[Behaviour notes](#behaviour-notes). Push reuses the hub's `/tail` stream, one
stream per workspace per session. More: <https://bricoleur.ai/projects/slackline/how-it-works>.

## What it deliberately does not do

- **It is not an archive, and only the server shapes prune.** On a hub or in `standalone.mjs`,
  messages older than `SLACKLINE_RETAIN_DAYS` (7) are pruned hourly. A local `mcp.mjs` process never
  prunes: it keeps what it has stored until you delete the sqlite file (the memory store keeps nothing
  after the process ends). Downloaded attachments stay
  on disk until you remove them.
- **It never reacts to messages on its own.** Acknowledging someone is the agent's job, with
  `slack_say` or a deliberate `slack_react`.
- **It never bulk-fetches users.** It looks up one user per new id, because bulk lookups
  invalidate session tokens.
- **`slack_search` reads only the rolling store.** It never calls Slack's search. Run
  `slack_history` first to search further back than slackline has seen.
- **Push is live and at most once.** A message that arrives while no session is listening is not
  replayed into the next one, and a failed delivery is logged and dropped.
- **Pushed text is content, never instructions.** It arrives inside a
  `<channel source="slackline" …>` tag that carries provenance only. What an agent does with it
  is your policy.
- **The hub is not hardened for the open internet.** TLS or a VPN is yours to provide.

## Getting a credential

slackline can authenticate two ways. They differ in what they can see, so pick deliberately.

| | **user token** (session) | **Slack app** (bot) |
|---|---|---|
| sees | every channel and DM **you** are in | only channels the bot was **invited** to; DMs only with the bot |
| posts as | you, with a 🤖 badge | its own bot identity, no badge |
| setup | one browser sign-in | create and install a Slack app |
| needs admin? | **no** | yes, to install the app |

**User token.** Run the collector. It opens Slack, you sign in once, and it captures the
`xoxc-…` token plus the `d` cookie. It needs a desktop browser; on first run it installs
Playwright's Chromium. Run it from `packages/src/`, or get it from a running hub's install page:

```bash
./collect.sh --out ~/.slackline-tokens.json                        # writes a file for SLACKLINE_TOKENS_FILE
./collect.sh --hub http://hub.example.com:8790 --secret <SECRET>   # or push straight to a hub
```

Tokens rotate, so re-run it to refresh. You can also set `SLACKLINE_XOXC` and `SLACKLINE_XOXD`
yourself.

**Slack app.** Create an app with Socket Mode enabled. That gives you an `xapp-…` app-level token
and an `xoxb-…` bot token. Set `SLACKLINE_APP_TOKEN` and `SLACKLINE_BOT_TOKEN` (both, always
together). `node ~/slackline/cli.mjs app init` can provision one for you; see
[Provisioning a Slack app](#provisioning-a-slack-app). Where a workspace has both credentials,
the app credential wins.

If you build the app by hand, it needs all of this, or slackline connects and then sees nothing:

- **Socket Mode: on**, and an app-level token with the `connections:write` scope (`xapp-…`).
- **Bot token scopes**: `channels:history`, `groups:history`, `im:history`, `mpim:history`
  (reading), `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`,
  `team:read` (name resolution), `chat:write` (`slack_say`), `reactions:write`
  (`slack_react`), `reactions:read` (reaction state on stored messages), and `files:read`
  if you want the attachment archive.
- **Event subscriptions**: `message.channels`, `message.groups`, `message.im`, `message.mpim`,
  plus `reaction_added` and `reaction_removed`.
- **Invite the bot to every channel you want it to see.** A bot token reads nothing until it is
  a member. `/history` returns `error: "not_in_channel"`, which is the usual cause of an empty
  channel in app mode.

## The three shapes

| | **In your agent** | **One process** | **A hub** |
|---|---|---|---|
| process | your agent's stdio MCP server | `node ~/slackline/standalone.mjs` | ingest + api + Postgres |
| storage | sqlite or memory | any | Postgres |
| serves | one agent | a few | many |
| start | `node mcp.mjs` | `node ~/slackline/standalone.mjs` | `docker compose up -d` |

"In your agent" is the first path above and "A hub" is the second. "One process" sits between
them: the full HTTP API and install page in a single always-on process, with no Postgres.

```bash
SLACKLINE_STORE=sqlite:$HOME/slackline.db \
SLACKLINE_SECRET=$(openssl rand -hex 24) \
SLACKLINE_TOKENS_FILE=$HOME/.slackline-tokens.json \
node ~/slackline/standalone.mjs                       # API and install page on :8790
```

It worked if `curl http://localhost:8790/health` answers `"ok": true`.

## MCP tools

`slack_whoami` · `slack_recent` · `slack_context` · `slack_thread` · `slack_history` ·
`slack_search` · `slack_say` · `slack_react`, plus `slack_app_status` and `slack_app_link` in
local mode only (app provisioning is the hub's job).

The read tools mostly serve the **rolling store**, which fills from messages seen live since the
connection started. A channel slackline has not been "on" for yet can look empty even though the
messages exist in Slack. Two things soften that:

- **`slack_history`** calls `conversations.history` directly and pages real history into the
  store. Reach for it when a channel predates the connection.
- **`slack_recent`** self-heals: on an empty store it backfills one page before answering,
  instead of claiming there is nothing there.

## Real-time push

Normally an agent reads Slack when it decides to. With push, new Slack messages are delivered
into a running session as they arrive.

**Every agent on a machine, routed by directory:** `node ~/slackline/cli.mjs agents install` wires Claude
Code, Codex, OpenCode and Muse at once, each through its own native mechanism, and
`~/.slackline/routes.json` decides which channels a session hears from the directory it was
started in. Start with [`docs/agents.md`](docs/agents.md), including its first section on what
routing a channel lets that channel's members do. Two limits to know up front: a Codex session
attached to Codex's shared background server gets no push, and a Muse session gets push only
inside tmux.

**One Claude Code project, by hand:** add `-e SLACKLINE_CHANNEL=1` to that project's MCP server,
and `-e SLACKLINE_CHANNEL_ONLY=C0EXAMPLE01` to restrict push to specific channels (without it the
agent receives everything the credential can see). Messages arrive as
`<channel source="slackline">` events. Act on `origin` `human` or `peer` and ignore `hub` (see
[Behaviour notes](#behaviour-notes)).

Claude Code only registers a channel when the server is named in a launch flag, every session,
and there is no settings key for it:

```bash
claude --dangerously-load-development-channels server:slackline    # local/dev
claude --channels server:slackline                                 # once org-allowlisted
```

`scripts/claude-channels.sh` adds the flag for you where a server will actually push, and
`scripts/csl` is the same with permission prompts skipped; see
[`docs/agents/claude-code.md`](docs/agents/claude-code.md).

### If push is silent

Claude Code skips channel registration for several reasons and **logs a reason rather than an
error**, so silence is the normal symptom. All of these must hold:

- the server declares the capability (slackline does, when `SLACKLINE_CHANNEL=1`);
- the connection negotiated a **legacy** protocol era: channels ride unsolicited notifications,
  which the modern revision has no path for;
- a first-party provider (not Bedrock or Vertex);
- `channelsEnabled: true` in managed settings, which **defaults to off** for Teams and Enterprise orgs;
- the server is named in this session's `--channels` list.

## Storage

Set `SLACKLINE_STORE` (or `DATABASE_URL` for Postgres):

| value | backend | use |
|---|---|---|
| `memory` | in-process | ephemeral, no dependencies |
| `sqlite` · `sqlite:/path.db` | `node:sqlite`, no native dependencies | single host, persists |
| `postgres` · `postgres://…` | PostgreSQL | multi-process split and `NOTIFY` fan-out |

All three implement the same interface. To move between them, or between hosts, copy and then
compare:

```bash
node ~/slackline/cli.mjs migrate copy   --from sqlite:$HOME/slackline.db --to postgres://user:pass@host/slackline
node ~/slackline/cli.mjs migrate verify --from sqlite:$HOME/slackline.db --to postgres://user:pass@host/slackline
```

Pruning applies to the hub and `standalone.mjs`. A local `mcp.mjs` store is never pruned: delete
the sqlite file to clear it; `SLACKLINE_STORE=memory` keeps nothing after the process ends.

`verify` exits 0 when the two stores match and 1 when they do not. `migrate export` and `import`
do the same through an NDJSON file.

## Configuration

| Var | Required | Default | Purpose |
|---|---|---|---|
| `SLACKLINE_SECRET` | hub and one-process shapes (strongly advised) | none | master key; gates every API route. Without it the servers only warn, and then only loopback callers and holders of a scoped key get past the auth check |
| `SLACKLINE_KEY` | consumers | none | scoped key, preferred over the master secret |
| `DATABASE_URL` | Postgres | none | Postgres connection URL; read by `db.mjs`, and by the Postgres tests as a fallback |
| `PGPASSWORD` | Postgres | none | database password (the compose file uses it to create the database) |
| `SLACKLINE_STORE` | no | `sqlite` (`postgres` if `DATABASE_URL` is set) | storage backend |
| `SLACKLINE_XOXC` / `SLACKLINE_XOXD` | credential | none | session token and `d` cookie |
| `SLACKLINE_TOKENS_FILE` | credential | none | path to a collector tokens.json |
| `SLACKLINE_APP_TOKEN` / `SLACKLINE_BOT_TOKEN` | credential | none | `xapp-`/`xoxb-` pair; both required together |
| `SLACKLINE_REMOTE` | remote mode | none | hub base URL; switches MCP into proxy mode |
| `SLACKLINE_ORG` | multi-workspace | none | which workspace to use; pin it on shared stores |
| `SLACKLINE_CHANNEL` | no | off | `1` enables real-time push |
| `SLACKLINE_CHANNEL_ONLY` | no | all | restrict push to these channel ids |
| `SLACKLINE_ROUTES` | no | off | `1` takes push channels from the routing table for the session's directory |
| `SLACKLINE_REMOTE_ONLY` | no | off | `1` makes the MCP server exit rather than fall back to local mode when no hub is configured |
| `SLACKLINE_PORT` | no | `8790` | API and install-page port |
| `SLACKLINE_RETAIN_DAYS` | no | `7` | rolling window; older messages pruned hourly, by the hub and `standalone.mjs` only (not by a local `mcp.mjs`) |
| `SLACKLINE_STATE_DIR` | no | `~/.slackline` | base directory for the database and the attachment archive |
| `SLACKLINE_DB_PATH` | no | `~/.slackline/slackline.db` (under `SLACKLINE_STATE_DIR`) | sqlite file, when `SLACKLINE_STORE` is `sqlite` with no path |
| `SLACKLINE_BLOB_DIR` | no | `~/.slackline/blobs` (under `SLACKLINE_STATE_DIR`) | attachment archive |
| `SLACKLINE_HEARTBEAT_MS` | no | `300000` | liveness line even when idle |
| `SLACKLINE_IDLE_RECONNECT_MS` | no | off | force a reconnect after this much silence |

`SLACKLINE_STATE_DIR` moves only the database and the attachment archive. The files that agent
push and remote mode use are always in `~/.slackline`: `config.json`, `routes.json`,
`agents.env`, `inbox/`, `logs/` and `run/`. The routing table can be pointed elsewhere with
`SLACKLINE_ROUTES_FILE`. The routing and delivery variables are listed in
[`docs/agents.md`](docs/agents.md).

## HTTP API

For the one-process and hub shapes. Data routes need `x-slackline-key` (scoped) or
`x-slackline-secret` (master), or the same values as `?key=` and `?secret=` query parameters
(a query string can end up in logs and browser history, so prefer the header); `/health` needs one too, except from loopback. `GET /` and
`POST /keys/request` need none. `?since=` on `/tail` replays stored messages only when the
request also names `channels`.

`GET /health` · `GET /tail` (live NDJSON) · `GET /query` · `GET /recent` · `GET /history` · `GET /thread` ·
`GET /context` · `GET /user` · `GET /channel` · `GET /file?rel=` · `POST /say` · `POST /react` ·
`POST /tokens` · `POST /apps` · `POST /keys/request` · `GET /` (install page).

Message routes return a `transcript` (readable by a person or a model) **and** structured
`messages` (`user_name`, `is_reply`, `reactions`, `origin`, `files[].local`). `/history` reports
`fetched`, `stored`, `oldest_ts` and `has_more`, plus `error: "not_in_channel"` (see
[Getting a credential](#getting-a-credential)).

Agents that consume the API should read [`SUBSCRIBER_GUIDE.md`](SUBSCRIBER_GUIDE.md).

## Security

- **Scoped keys** (`slk_…`) are the intended way to authorise a consumer: each key reaches only
  the workspaces it was issued for, so you decide which machines can act as which Slack identity.
  The master `SLACKLINE_SECRET` reaches everything, so keep it on the hub. Issue keys from the
  CLI (`node ~/slackline/cli.mjs key add --label "laptop agent" --orgs acme`) or by approving a request in a
  Slack DM: [`docs/keys.md`](docs/keys.md).
- **Loopback is trusted, and where that bites depends on where the hub runs.** A request whose
  peer address is `127.0.0.1`, `::1` or `::ffff:127.0.0.1` is treated as holding the master secret,
  with no header (`api.mjs`), and no setting turns that off. In the Docker Compose deployment the
  API runs in a container, so loopback is the container's own: a request from the host, or from a
  TLS-terminating proxy on the host, arrives from the Docker bridge and needs the secret like any
  other caller. When the hub's process runs directly on the host (`standalone.mjs`, or `server.mjs`
  outside a container), or in a container that shares the host's or a proxy's network namespace,
  every local process, a same-host reverse proxy included, arrives over loopback and is trusted as
  the master. There the secret protects the hub from nothing local: terminate TLS on another host,
  or keep the hub on a private network or VPN. The hub is not hardened for the public internet.
- **Your Slack session token is a full login to your Slack account.** The collector's
  `--out` file holds it with the `d` cookie (the collector sets mode 0600), and a hub keeps the
  same pair in its store's `tokens` table, unencrypted. The sqlite store file is created without a
  mode of its own, so it takes your umask; a Postgres database is protected by its password.
  Keep these files and that database private.
- **The compose file publishes Postgres.** `docker-compose.yml` maps the database to host port
  `PG_EXPOSE` (default 5440) on all interfaces, protected only by `PGPASSWORD`. `PG_EXPOSE` changes
  the port; it does not switch it off. You need the mapping only to reach the database from
  outside the host. Otherwise firewall that port or remove the `ports:` entry from the `postgres`
  service; `api` and `ingest` reach it over the compose network.
- The store holds other people's messages, including your DMs and private channels. Restrict
  access to the database.
- `.env`, `*tokens*.json`, `*.db` and `blobs/` are gitignored. Never commit them.

To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## Provisioning a Slack app

The `app` subcommand creates or attaches an app credential and keeps it in the active store's
`apps` table, so it works in every shape. Run it from a checkout as `node ~/slackline/cli.mjs …`, or run
`npm link` once to get a `slackline` command:

```bash
node ~/slackline/cli.mjs app init      # provision a new app (needs the Slack CLI and `slack auth login` once)
node ~/slackline/cli.mjs app link --app-token xapp-... --bot-token xoxb-...   # attach one you made by hand
node ~/slackline/cli.mjs app status    # what is provisioned; never prints token values
node ~/slackline/cli.mjs app doctor    # diagnose: missing credentials, revoked token, Socket Mode disabled
```

`init` uses an undocumented but empirically stable Slack CLI path to capture both tokens
unattended. That path is an optimisation, never a requirement: when it cannot complete, `init`
prints the exact App Settings click-path and the `app link` command to finish by hand.

A running hub can also be handed a credential without a restart through `POST /apps`; every host
picks it up within seconds. `slack_app_status` and `slack_app_link` mirror this for agents. App
*creation* is deliberately not an MCP tool: it shells out to the Slack CLI and can need a human,
which is not something an agent should trigger in conversation.

## Behaviour notes

- **Loop guard.** Your own posts come back as `origin=hub`. Filter on `origin=human,peer`, and
  keep a client-side check too. It is the difference between an agent that converses and one
  that answers itself in a loop.
- **Deletions and edits** are tracked. Deleted messages are kept but left out of agent views
  unless a request asks for them (`include_deleted=1`).
- **Pruning** runs only in the hub and `standalone.mjs`; a local `mcp.mjs` store keeps everything it
  has stored until you delete the file.
- **Attachments** are downloaded to `blobs/<org>/<channel>/<date>/` and served through `/file`.

## Docs

| | |
|---|---|
| [`docs/agents.md`](docs/agents.md) | every agent on a machine: routing and push |
| [`SUBSCRIBER_GUIDE.md`](SUBSCRIBER_GUIDE.md) | for agents consuming the HTTP API |
| [`docs/deploy.md`](docs/deploy.md) | Docker deployment, image tags, CI publishing |
| [`docs/keys.md`](docs/keys.md) | scoped consumer keys, the Slack-DM approval flow |
| [`docs/bridge.md`](docs/bridge.md) | driving an agent in tmux from a Slack channel |
| [`docs/rtm-deprecation.md`](docs/rtm-deprecation.md) | RTM vs Socket Mode |
| [`SECURITY.md`](SECURITY.md) | reporting a vulnerability |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | working on slackline |

## Development

```bash
npm test          # node --test test/*.test.mjs
```

Eight tests need a PostgreSQL and skip unless one answers at `SLACKLINE_TEST_PG_URL`, then
`DATABASE_URL`, then `postgres://slackline:slackline@localhost:5440/slackline`. They **write** to
whatever database they find, so if a hub's `DATABASE_URL` is in your shell, set
`SLACKLINE_TEST_PG_URL` to a throwaway database or unset `DATABASE_URL` before `npm test`.

This repo is the tool itself. A running deployment should use the published image,
`ghcr.io/bricoleur-ai/slackline`, from its own directory rather than a checkout; see
[`docs/deploy.md`](docs/deploy.md).

**Release verification.** The automated suite and stand-in hub checks cover the exported tree.
The formal real-Slack acceptance check across all four agent adapters was waived for the initial
release. The maintainer reports using slackline across multiple hosts and Slack accounts; that
report is separate from the automated checks and the version-specific observations in
[`docs/agents/`](docs/agents/).

## The full guide

<https://bricoleur.ai/projects/slackline>

<!-- bricoleur:footer -->
---
Part of **[bricoleur.ai](https://bricoleur.ai)** · [Full guide](https://bricoleur.ai/projects/slackline) · MIT © 2026 DynamoFoundry LLC
<!-- /bricoleur:footer -->
