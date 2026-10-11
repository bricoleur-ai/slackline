# Deploying slackline

Two ways to run slackline in Docker. Pick one per host — do not run both against the same
ports.

| | when |
|---|---|
| [No-clone](#no-clone-adopt-a-published-image) | you just want a running slackline; you are not changing its code |
| [Develop](#develop-build-from-a-checkout) | you are iterating on slackline itself |

Both use the same three services (`postgres`, `api`, `ingest`) and the same `.env`. The only
difference is whether `api`/`ingest` come from a pulled image or a local build.

---

## No-clone: adopt a published image

You need exactly two files — no `git clone`, no local build.

1. **Download** `docker-compose.yml` and `.env.example` into an empty directory:

   ```bash
   mkdir -p ~/srv/slackline && cd ~/srv/slackline
   base=https://raw.githubusercontent.com/bricoleur-ai/slackline/main
   curl -fsSLO "$base/docker-compose.yml"
   curl -fsSL  "$base/.env.example" -o .env.example
   ```

2. **Private fork only: log in to GHCR.** With a public repo the image
   `ghcr.io/bricoleur-ai/slackline` pulls anonymously and this step does not apply. If you
   run slackline from a private fork, its package is private too, and a plain
   `docker compose up -d` fails to pull with `unauthorized` or `denied` until you authenticate
   once per host:

   ```bash
   # Personal access token with at least `read:packages`, or `gh auth token` if you use the
   # GitHub CLI and it's already authenticated against an account with repo access:
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
   ```

   The credential is cached by the Docker CLI, so it only needs to happen once per host. For a
   host you do not log in to, use a fine-scoped PAT stored the same way you already store other
   host secrets — not committed anywhere.

3. **Configure.**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set the two required values (compose refuses to start without them —
   `PGPASSWORD` and `SLACKLINE_SECRET` are marked `:?` in `docker-compose.yml`, so a missing
   value is a hard error, not a silent default):

   ```bash
   SLACKLINE_SECRET=$(openssl rand -hex 24)
   PGPASSWORD=$(openssl rand -hex 16)
   ```

   Paste those into `.env`. Everything else in `.env.example` has a working default; change
   `SLACKLINE_IMAGE` only if you need to pin a specific tag instead of floating `latest` (see
   [Tags](#tags-what-publish-imageyml-pushes) below).

4. **Start it.**

   ```bash
   docker compose up -d
   ```

   With no `docker-compose.dev.yml` in the directory, compose has nothing to build — it pulls
   `${SLACKLINE_IMAGE:-ghcr.io/bricoleur-ai/slackline:latest}` and starts `postgres`, `api`,
   and `ingest`. See [Verifying it came up](#verifying-it-came-up).

5. **Point a Slack workspace at it.** Open `http://<host>:8790/` (or `/install`) — no secret
   needed, it's the public bootstrap page — and follow it to download a collector or provision
   an app credential (`POST /apps`; see `SUBSCRIBER_GUIDE.md` in the repo for the full API).

### Autostart after a reboot

Two independent things both need to survive a reboot with nobody logged in:

- **Every service in `docker-compose.yml` has `restart: unless-stopped`.** Once the containers
  are running, Docker restarts them on crash and brings them back after the Docker daemon
  restarts — *as long as the Docker daemon itself starts*.
- **The Docker daemon must start at boot without a login.** On systemd hosts this is normally
  already true (`docker.service` is enabled by the Docker install), but verify it:

  ```bash
  systemctl is-enabled docker      # want: enabled
  systemctl enable docker          # if not
  ```

  `unless-stopped` specifically means "come back after a daemon/host restart, but stay down if
  an operator ran `docker compose stop`" — that's the behavior you want here; `always` would
  also fight a deliberate stop.

There is nothing to `systemctl enable` for slackline itself in this path — the containers are
not systemd units. (The bare-metal `deploy/slackline-ingest.service` is a *different* deployment
of slackline, for a host running it directly under systemd rather than in Docker. Don't run both
against the same ports on the same host.)

---

## Develop: build from a checkout

You have `git clone`d the repo and want `api`/`ingest` built from your working tree instead of
pulled.

```bash
git clone git@github.com:bricoleur-ai/slackline.git
cd slackline
cp .env.example .env      # set SLACKLINE_SECRET + PGPASSWORD, as above
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml` is an override: it replaces `build:` for `api` and `ingest` so compose
builds `Dockerfile` from `.` instead of pulling, and sets `pull_policy: build` so a same-tagged
image already in your local cache never shadows a source change. `docker-compose.yml` on its own
is untouched by this — it's still the file the no-clone path downloads and runs standalone.

After editing source, rebuild with the same `-f -f ... up -d --build` command (or
`docker compose -f docker-compose.yml -f docker-compose.dev.yml build` then `up -d` if you don't
want to also recreate `postgres`). Everything else — `.env`, verifying, logs — is identical to
the no-clone path below.

---

## Verifying it came up

`GET /health` requires the shared secret **except from loopback** (`api.mjs`'s `authed()` treats
`127.0.0.1`/`::1` as pre-authorized — that's what lets the container's own Docker healthcheck
call it with no credential). From outside the container, present the secret:

```bash
curl -s -H "x-slackline-secret: $SLACKLINE_SECRET" http://<host>:8790/health
```

A healthy response looks like:

```json
{ "ok": true, "messages": 0, "deleted": 0, "users": 0, "channels": 0, "orgs": 0, "orgs_live": [] }
```

`orgs_live` lists workspaces with an active ingest connection — empty until you provision a
token or app credential via the install page.

Also check container-level health, which is what actually gates `restart`/orchestration
decisions:

```bash
docker compose ps       # STATUS column: "healthy" / "unhealthy" / "starting"
```

- **`api`**'s healthcheck hits `GET /health` over loopback from inside the container. A 200
  means the HTTP server is genuinely accepting and answering requests — not just that the
  process hasn't exited. A wedged-but-technically-running `api` container shows `unhealthy`
  rather than "running" indefinitely.
- **`ingest`**'s healthcheck is weaker, on purpose, and it's worth knowing exactly how:
  `ingestd.mjs` has no HTTP surface (it only holds Slack socket(s) and a Postgres connection),
  so the ingest process has no health endpoint of its own.
  Instead, the healthcheck opens a **fresh** Postgres connection from inside the container,
  using the same `DATABASE_URL` credentials `ingestd.mjs` itself uses, and runs `SELECT 1`. That
  proves the one dependency ingest cannot do anything without — it does **not** prove the Slack
  socket is connected, or catch a wedged-but-alive event loop that still happens to hold its own
  DB connection open. Stopping `postgres` flips `ingest` to
  `unhealthy` within a few health-check cycles, and both `api`/`ingest` recover on their own
  once `postgres` comes back (they crash on the lost connection, and `restart: unless-stopped`
  brings them back). A stronger ingest signal (e.g. "is the Slack socket actually open") would
  need a real heartbeat inside `ingestd.mjs`; there is none today.

## Reading logs

```bash
docker compose logs -f api        # HTTP API + install page
docker compose logs -f ingest     # the Slack connection-holder
docker compose logs -f postgres
docker compose logs -f            # everything, interleaved
```

Add `--since 1h` (or any duration) to bound it. `ingest` and `api` both migrate the schema on
startup; on a *first* boot you may see one of them log a harmless duplicate-type error while the
other wins the race creating a Postgres composite type — both processes recover and reach
"API on :8790" / "slackline ingest up" regardless. The race is in the `db.mjs` migration code and is
cosmetic, not a failure.

## One Slack connection per app — consumers must use remote mode

Found in real use, after roughly two weeks of silent partial message loss.

A consumer was configured in **local** MCP mode: it had the same `SLACKLINE_APP_TOKEN` as the
hub and a `DATABASE_URL` pointing at the hub's own Postgres. That looks reasonable — same
credential, same database, surely the same result — and it is wrong.

Slack Socket Mode **load-balances events across every open connection for an app**. That is a
deliberate HA feature: with two connections open, each event is delivered to exactly one of
them. So roughly half of the workspace's events went to the hub's `ingest`, and half went to the
consumer's own in-process socket.

Both wrote to the same database, so the store looked complete and nothing appeared broken. But
the hub's live fan-out is driven by `pg_notify`, and **only `ingestd.mjs` emits it** —
`mcp.mjs` never does. Events that landed on the consumer's connection reached the database and
were never announced, so:

- every `/tail` subscriber missed about half of live messages
- the consumer's own channel push fired for only about half
- `slack_recent` still showed everything, because it reads the store — which is why this
  presents as "push is unreliable" rather than "ingest is broken"

**The rule:** exactly one process per Slack app holds the socket. Everything else is a client.

```bash
# WRONG — a second Socket Mode connection for the same app
SLACKLINE_APP_TOKEN=xapp-…  SLACKLINE_BOT_TOKEN=xoxb-…  DATABASE_URL=postgres://…

# RIGHT — proxy to the hub; no local socket, no local store
SLACKLINE_REMOTE=http://<hub>:8790  SLACKLINE_KEY=slk_…  SLACKLINE_ORG="Acme"
```

Remote mode is also less privileged: the consumer holds a key scoped to one org instead of the
app credential for the whole workspace.

To check a running deployment, count the sockets — more than one process with an established
connection to Slack for the same app is the bug:

```bash
ps aux | grep -E 'mcp\.mjs|ingestd' | grep -v grep     # who is running?
ss -tnp | grep -E 'ESTAB.*:443'                        # who holds a Slack connection?
```

## Tags: what `publish-image.yml` pushes

`.github/workflows/publish-image.yml` builds and pushes on every push to `main` and on version
tags (`v*.*.*`):

| tag | when |
|---|---|
| `latest` | every push this workflow runs (main or a version tag) |
| `<short-sha>` | every push — pin to an exact build regardless of `latest` moving |
| `<version>` (e.g. `1.4.0`) | only when the trigger was a version tag |

Set `SLACKLINE_IMAGE=ghcr.io/bricoleur-ai/slackline:<tag>` in `.env` to pin instead of
floating `latest`.

Images are built for `linux/amd64` and `linux/arm64` on every push (cross-compiled with QEMU on
GitHub's amd64 runners) — this repo has no native npm dependencies (`pg`, `ws`, and
`@modelcontextprotocol/sdk` are all pure JS), so there's no `node-gyp` compile step to pay for
twice, and the arm64 leg stays cheap. That's what makes building both architectures on every
push reasonable here rather than a build-time problem; it's what makes an Apple-silicon host a
`docker compose pull` away from working with zero extra steps.

## Attaching a remote agent to a central hub

Once a hub is running on one host (say `hub.local`), agents on *other* hosts should read/write Slack
through it rather than each holding their own Slack connection (wasteful, and risky for a
user-mode token shared across several processes) or improvising `curl` wrappers around the hub's routes. `mcp.mjs` has a **remote client mode** for
exactly this: set `SLACKLINE_REMOTE` and it never touches `db.mjs`/`creds.mjs`/Slack at all —
every tool call becomes an HTTP request to the hub's `api.mjs` (see `remote.mjs`).

On the remote host's MCP config, instead of the local-mode credential env vars:

```
SLACKLINE_REMOTE=http://hub.example.com:8790     # the hub's base URL
SLACKLINE_SECRET=<same secret as the hub>  # sent as the x-slackline-secret header
SLACKLINE_ORG=acme                        # default org; omit only if the hub serves exactly one
```

That's it — `slack_recent`/`slack_context`/`slack_thread`/`slack_history`/`slack_search`/
`slack_say`/`slack_react`/`slack_whoami` all work identically to local mode from the agent's
point of view (same tool
names, same input schemas); `slack_whoami` reports the hub's URL and its live orgs instead of an
`auth.test` result, since identity now belongs to the hub, not this process. `slack_app_status`/
`slack_app_link` are not offered remotely — credential provisioning is the hub's job.

**Channel push** (`SLACKLINE_CHANNEL=1`) still works, backed by one long-lived `GET /tail`
subscription per MCP process instead of a Slack socket — each remote agent gets its own
subscription and its own in-memory resume position (`?since=`), so two agents on the same host
never share a watermark.
`SLACKLINE_CHANNEL_ONLY` still scopes it to specific channel ids. If the hub is unreachable (or
the secret is wrong) when push is enabled, the process fails immediately with the hub URL in the
error — it will not sit there looking connected while silently retrying.

One real gap worth knowing: the hub's `/tail` only replays via `since` when a `channels` filter
is present (`api.mjs`'s gap-fill check) — so set `SLACKLINE_CHANNEL_ONLY` if you want a reconnect
to be gap-free; an all-channels remote subscription can miss messages that arrived during a drop.

No new dependency is needed on the remote host beyond Node itself — `remote.mjs` uses `fetch`.
