# Scoped consumer keys

`SLACKLINE_SECRET` is still a master credential — it grants every org, unchanged. Scoped keys
are an additive, optional layer for a hub serving multiple Slack orgs to multiple consumers,
where not every consumer should reach every identity.

## Hub side

```
slackline key add --label "laptop agent" --orgs acme       # prints the key ONCE
slackline key add --label "admin" --orgs '*'               # all identities
slackline key list                                         # id/label/orgs/last_used — never the key
slackline key revoke <id>
```

`--orgs` is a comma-separated list of org names (the same names `slackline app` and `?org=`
use), or `*` for every org on the hub. Only `key add`'s stdout ever shows the raw key — save it
immediately, it is not recoverable. The store keeps only `sha256(key)`; a stolen database yields
no working keys. sha256 (not a slow password KDF) is the right call here because a key is a
192-bit random token, not a human-guessable password — brute-forcing the hash back to the key is
computationally infeasible regardless of hash speed, so a slow KDF would add latency without
adding real protection.

## Wire format

Send the key as `x-slackline-key: <key>` (or `?key=` for routes that don't support headers, e.g.
`/tail` from a plain browser/curl -N). It is checked alongside `x-slackline-secret` /
`?secret=` — present either, not both. Loopback requests (127.0.0.1/::1 on the hub itself) stay
fully trusted with no header at all, exactly as before.

An unknown or revoked key gets a flat `401`. A key presented for an org outside its scope gets
`403` — never a quiet empty result, since that would look exactly like "no messages matched" and
hide a misconfigured key from the operator.

## Consumer side

`~/.slackline/config.json`:

```json
{ "hub": "http://hub.example.com:8790", "key": "slk_..." }
```

`keys.mjs` exports `loadConsumerConfig()` to read it (mirrors `envfile.mjs`'s `loadEnvFile()` —
same "missing file is not an error" contract, different file/shape). It warns to stderr if the
file isn't mode `0600`, since it holds a credential:

```
chmod 600 ~/.slackline/config.json
```

## Getting a key over Slack, without SSH (`keyrequest.mjs`)

`slackline key add` needs a shell on the hub. `POST /keys/request` is the same operation reached
over HTTP by anything that can't get that shell — an agent, a CI job, a teammate's laptop — mediated
by a human approving in Slack instead of a secret the caller doesn't have yet:

```
POST /keys/request  {label, orgs, requester}
  -> 200 {request_id, poll_token, code, expires_at}
  -> DMs the configured approver: label, orgs, requester, and `code`

GET /keys/request/<request_id>?token=<poll_token>
  -> {status: "pending"|"approved"|"denied"|"expired", key?: "slk_..."}
```

The approver replies **in that same Slack DM** with `approve <code>` or `deny <code>`. Nothing
else grants a key — there is no timeout-approves, no auto-approve, no bypass. Poll until
`status` moves off `"pending"`; a `"approved"` response carries the raw key exactly once — the
next poll (even with the correct token) gets `{status:"approved"}` with no `key` field. Save it
immediately, same as `key add`'s stdout: slackline never shows it again.

### Configuration

Set on the hub process's environment (picked up directly by `api.mjs` — no other file needs
edits, since `standalone.mjs`/`server.mjs` already run this code in the same process):

```
SLACKLINE_KEY_APPROVER=U0123456          # the approver's Slack user id (not @handle, not display name)
SLACKLINE_KEY_APPROVER_ORG=acme         # which of the hub's orgs sends the DM and watches for the reply
# optional, shown with their defaults:
SLACKLINE_KEY_REQUEST_TTL_MS=600000          # 10 min — a request past this can never be approved
SLACKLINE_KEY_MESSAGE_TTL_MS=300000          # 5 min — how long the delivered-key DM survives before self-deleting
SLACKLINE_KEY_REQUEST_MAX_PENDING=25         # hub-wide concurrent pending cap
SLACKLINE_KEY_REQUEST_RATE_MAX=5             # requests...
SLACKLINE_KEY_REQUEST_RATE_WINDOW_MS=600000  # ...per this window, per source address
```

Leaving `SLACKLINE_KEY_APPROVER`/`_ORG` unset does not disable the routes — `POST /keys/request`
still answers, with a `503` explaining key requests aren't configured — so an unconfigured hub is
inert rather than silently missing behavior a caller might otherwise assume is available.

**Deploying under the repo's `docker-compose.yml`:** that file lists `api`'s environment
explicitly rather than forwarding the whole `.env`, so these vars need adding to its `environment:`
block (or an `env_file:` reference) to actually reach the container. That edit is deployment
config, not this feature's code, and is left to the operator per-environment.

### How the approver's reply is detected

The approver's DM reply is picked up through the hub's existing ingest → store → bus pipeline —
the same `bus.on('event', …)` mechanism `GET /tail` already uses — rather than a second Slack
listener. `keyrequest.mjs` opens the DM itself (`conversations.open`, cached for the process's
lifetime — one DM, reused for every request), so whichever credential mode
`SLACKLINE_KEY_APPROVER_ORG` runs under, it is guaranteed to be "a party to" that conversation:

- **App mode** (Socket Mode) only delivers events for conversations the bot is part of — but a DM
  the bot itself opened always qualifies, so this works, *provided* the Slack app has a DM message
  event subscription enabled (`message.im`, or the app's IM/message scope) — an app-configuration
  prerequisite, not something this code can detect or set up.
- **User mode** (RTM) sees every DM the account is party to as a strict superset of that, so it
  needs no extra Slack-app configuration at all.

Either identity works for *this specific* DM for that reason; the choice of
`SLACKLINE_KEY_APPROVER_ORG` is purely an operational one (which identity should visibly be the
one asking), not one forced by credential mode.

A reply is only ever treated as a decision when **all** of these hold: it is a plain chat message
(not a reaction/edit/delete signal), on the configured `approver_org`, in the one DM channel this
flow itself opened, from `rec.user === SLACKLINE_KEY_APPROVER` — the Slack **user id**, never a
display name or handle — and it contains both a recognizable 6-character code and an
approve/deny keyword. Anything else in that DM (small talk, a typo'd code, someone else in a
group DM) is silently ignored.

### Abuse surface of the unauthenticated endpoint

`POST /keys/request` has to be reachable with no credential — that is the entire feature. What
bounds it:

- **Per-address rate limit** (`SLACKLINE_KEY_REQUEST_RATE_MAX` per `_WINDOW_MS`, fixed window, in
  memory) — caps how fast one source can generate requests (and therefore DMs) at all.
- **Hub-wide pending cap** (`SLACKLINE_KEY_REQUEST_MAX_PENDING`) — the real bound on worst-case DM
  volume: once that many requests are simultaneously unresolved, every further request is
  rejected with `429` until one is decided or ages out past its TTL. Combined with the TTL, total
  DM volume from an attacker who never gets a reply is capped at roughly
  `maxPending` DMs per `ttlMs` window, indefinitely — not unbounded spam.
- **Org validation before any DM is sent** — `orgs` must name orgs the hub actually has live
  credentials for (or `*`); a request for a nonexistent org is rejected with `400` before it ever
  reaches the approver, so probing costs the attacker a rate-limit slot and nothing else.
- **No key is ever issued from this route.** The worst a successful flood of requests can do is
  generate DM noise for the approver — every one of them still requires that person's own
  Slack reply, individually, to produce a key. There is no code path from request volume to key
  issuance.

### What an operator could misconfigure into an auto-approving door

None of the above weakens if these are set correctly, but a few configuration choices *would*
undermine the "always a real human decision" guarantee:

- **Pointing `SLACKLINE_KEY_APPROVER` at a shared/automated Slack account** (a bot that
  auto-replies, or a shared team account several people can post from without individual review)
  turns "a human approved this" back into "something with access to that account approved this."
  The approver should be one specific person's own Slack identity.
- **`SLACKLINE_KEY_APPROVER` equal to `SLACKLINE_KEY_APPROVER_ORG`'s own identity** (approving via
  a self-DM) is accepted by the code but defeats the separation the feature is for — there's no
  longer a second party in the loop.
- **An approver who develops the habit of replying `approve <code>` without reading the message.**
  The DM always shows the requested `orgs` (including a literal `*` for "every org on the hub")
  before asking for a decision — that's the actual security boundary, and it only works if someone
  reads it. A caller can request anything; only a considered approval should grant it.
- **Posting the key to a channel instead of a DM** isn't possible through this flow as built (the
  destination is always the resolved 1:1 DM), but is worth naming: pointing
  `SLACKLINE_KEY_APPROVER_ORG` at an identity where the "approver" user id actually resolves to a
  multi-person conversation would let *anyone* in it reply — the per-message user-id check still
  holds, but the operator's mental model of "only the approver sees this" would already be wrong.

### The DM-exposure tradeoff

Posting a raw key into a Slack DM is a real exposure — Slack stores and indexes message content
server-side, independent of this app. This flow does not avoid that; it narrows it: the message
that carries the key is deleted (`chat.delete`) after `SLACKLINE_KEY_MESSAGE_TTL_MS` (default 5
min), and the message itself says plainly that it will vanish and to save the key immediately.
Deletion removes it from the channel and from Slack's own search/history for members going
forward; it does not retroactively purge anything already exported, audit-logged, or cached by
Slack Enterprise Grid-style compliance exports — this is a mitigation, not a guarantee. Treat a
key delivered this way the same as any other Slack DM content from a compliance standpoint, and
prefer a short `SLACKLINE_KEY_MESSAGE_TTL_MS` over a long one.

### What is never stored

The `key_requests` table (created alongside `keys`; see `stores/{memory,sqlite,postgres}.mjs`)
holds `poll_hash` (a hash of the poll token) and, once approved, `key_id` (the key's *public* id,
for audit/revocation) — never the raw key, and never the raw poll token. The one raw key this
flow ever produces lives only in an in-process map from the moment `keys.mjs`'s `createKey()`
returns until the requester's first successful poll collects it (or an internal GC timer drops
it, so an approved-but-never-polled request doesn't hold it forever) — same "only `createKey()`
ever returns key material, and only once" contract `keys.mjs` already documents for itself.
`slackline key requests [--status pending|approved|denied|expired]` lists this table's metadata
from the CLI for operator visibility — safe to dump wholesale, for the same reason.

### Test coverage note

`key_requests`' store methods are covered against `memory` and `sqlite::memory:` (see
`test/keyrequest-store.test.mjs`) but deliberately not against Postgres: port `localhost:5440`, the
default the Postgres tests fall back to, is also where a locally deployed hub's database
listens, so on a machine that runs a hub a test that reached it would touch real data. (The
Postgres tests take their database from `SLACKLINE_TEST_PG_URL`; point it at a disposable
database.) `stores/postgres.mjs`'s `key_requests` SQL is reviewed against its sqlite/memory siblings and `node --check`ed instead;
`test/keys-store.test.mjs` already carries this same precedent for the `keys` table.
