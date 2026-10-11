# slackline — Subscriber Guide (the HTTP API)

> Added slackline as an **MCP server**? Use its tools instead — `slack_recent`, `slack_context`,
> `slack_thread`, `slack_history`, `slack_search`, `slack_say`, `slack_react`. This guide covers
> the **HTTP** modes (standalone / hub), where you subscribe to a live `/tail`.

How any program or agent subscribes to Slack in real time via slackline, reacts, and replies —
**without polling and without holding a Slack token**: the `/tail` stream, its filters, the
event kinds, keepalives, the loop guard, and the `/say` and `/react` bodies.

## 0. What you get
The hub holds a live Slack socket **as the user** and pushes messages to you the moment
they land (~1s). You subscribe to a filtered live stream, pull richer context on demand,
and reply through the hub. You never touch the Slack token.

Hub + auth (the defaults below are for a hub on localhost; for a shared hub, ask its
operator for the base URL and a scoped key):
```
HUB=http://localhost:8790        SECRET=<your SLACKLINE_SECRET>
```
Every data request needs the header `x-slackline-secret: <SECRET>` (loopback is exempt, but
in-container/remote callers must send it — always send it).

## 1. Find your channel id
- From Slack: right-click the channel → Copy link → the `C…`/`D…` id is in the URL.
- Confirm the hub is capturing it: it captures every channel **the user is a member of**
  (public joined, private, DMs, group DMs). If you're not a member, join in Slack first.

## 2. Subscribe
```
curl -sN "$HUB/tail?org=acme&channels=C0EXAMPLE01,C0EXAMPLE02" -H "x-slackline-secret: $SECRET"
```
Each stdout line is one live message as JSON:
```json
{"channel","channel_name","ts","thread_ts","is_reply","time","user","user_name","text","has_files","files":[...],"origin"}
```
Filters (combine with AND, all server-side — you only receive matching events):
`channels=C1,C2` · `origin=human,peer` (exclude your own `hub` posts — the loop guard as a filter) ·
`types=message,reaction_added` (limit event kinds) · `mentions=1` (only @-mentions of you) ·
`user=U…` · `keywords=foo,bar` (lowercased contains) · `since=<ts>` (gap-fill on reconnect).

**Watching several channels? Use ONE tail** with a comma list — every event carries its own
`channel` + `channel_name`, so route by `event.channel` and reply with `/say` to that same
channel. Don't open one socket per channel.

**Event kinds.** A normal message event has no `type` field. The tail also emits typed signals
you should handle (or skip): `{type:"message_deleted",channel,ts}`, `{type:"message_edited",channel,ts,text}`,
`{type:"reaction_added"|"reaction_removed",channel,ts,emoji,user,user_name}`. Deleted messages are
redacted in `/thread`/`/context`/`/recent` (shown as `[deleted message]`, content hidden) — add
`include_deleted=1` to see the archived content. Message objects also carry a `reactions` map
(`{emoji:[userIds]}`) and, for attachments, `files[].local` (fetch bytes via `GET /file?rel=<local>`).

**Keepalives.** Every ~25s with no traffic, the hub writes a bare `\n` on the stream — a real byte
on the wire, not a no-op — so a healthy-idle tail and a dead connection are distinguishable: no
bytes for well over 25s means the connection is actually gone, not that the channel is quiet.
Your line parser must skip blank lines (split on `\n`, drop empty results) before treating each
one as a JSON object. A consumer without that skip breaks on the first keepalive. `jq` itself
handles a blank line fine (`curl -sN .../tail | jq -rc --unbuffered '.'` keeps running across a
keepalive with jq 1.7) — the real risk is a consumer that does its own `JSON.parse(line)` per
line (e.g. a JS/Node reader) without the blank check first, which throws on an empty string.

**Reconnecting? Pass `since=<last ts you saw>`** — the tail replays stored messages since that ts,
then goes live, so an API redeploy or a brief drop leaves no gap. The Slack connection itself lives
in a separate connection-holder process, so API redeploys never drop it — only your tail reconnects.

### The loop guard — always read `origin`
- `human` — the workspace owner typed it → act on it
- `peer`  — someone else → act on it
- `hub`   — an agent posted it via slackline, **including your own replies echoing back
  through the socket** → **ignore it**, or you'll react to yourself in a loop.

The guard keys on *who posted it through the hub*, not on user id — so a message the human
types directly (even as the same Slack user the hub posts as) correctly arrives as `human`,
not `hub`.

If this org is running in **app mode** (a Slack app/bot credential instead of a user token),
`origin=hub` also covers the bot's own posts — same filter, same meaning, no special-casing
needed on your end.

**Defense in depth (recommended for unattended agents):** even with `origin=human,peer`
filtering this server-side, keep a cheap local assert that also drops `origin=="hub"`. The
failure mode if the server filter ever regresses — answering your own posts in a channel real
people read — is silent and asymmetric; a redundant local check costs nothing and fails closed.
(On startup the API also re-tags stored messages that match its outbound record as `hub`, but a
local assert still earns its keep on very old replays.) Because the hub confirms outbound
provenance before classifying, your **own posts arrive on the tail ~1.5s after you send them**
(tagged `hub`); size timeouts accordingly.

## 3. Reply & react (the hub posts for you)
```
POST $HUB/say    {"org":"acme","channel":"C0EXAMPLE01","text":"…","thread_ts":"<parent ts?>"}
POST $HUB/react  {"org":"acme","channel":"C0EXAMPLE01","ts":"<msg ts>","emoji":"eyes"}
```
`/say` posts as the user and prepends a `:robot_face:` 🤖 badge so agent posts are clearly
attributed. Pass `"no_badge":true` only if you explicitly need it off. Reply in-thread by
passing the parent's **full-precision** `thread_ts` (from the event) — never a truncated ts.

## 4. Context on demand (replaces manual re-reads)
```
GET $HUB/thread?org=acme&channel=C0EXAMPLE01&thread_ts=<ts>   # full thread, hydrates if needed
GET $HUB/context?org=acme&channel=C0EXAMPLE01&ts=<ts>         # msg + thread/snippet + participants
GET $HUB/recent?org=acme&channel=C0EXAMPLE01&limit=20         # recent channel history (self-heals — see below)
GET $HUB/history?org=acme&channel=C0EXAMPLE01&oldest=&latest= # backfill from Slack, no ts required
GET $HUB/query?org=acme&q=<text>&limit=30                     # text search over the rolling store
```
Each returns a `transcript` (plain text with resolved names + `[file:]` markers, easy to
read/feed) **and** structured `messages`. Files: use `files[].url` to fetch bytes only when
the task needs the image/attachment.

`/recent`/`/query`/`/thread`/`/context` only ever read the rolling store (fills from live
traffic since the hub connected), so a channel the hub hasn't seen anything on yet comes back
empty even though the messages exist in Slack. `/recent` self-heals: on an empty store it
fetches one backfill page from Slack first. `/history` is the explicit version — it always
backfills (optionally bounded by `oldest`/`latest`, paged/capped so a huge channel can't run
away) and reports `fetched`/`stored`/`has_more`/`oldest_ts`, plus `error: "not_in_channel"` when
the hub's credential was never invited to the channel (the #1 real-world cause — invite it and
retry). `/query` (search) deliberately stays store-only and never calls Slack — its
`search.messages` isn't available to bot tokens; run `/history` first if you need messages from
before the hub started watching.

## 5. Replacing a polling loop
A polling loop is often doing double duty: besides reading Slack, it may be the only thing that
wakes a program for **non-Slack** jobs — a scheduled health check, a nightly export, a deadline
check. **The tail never fires for those**; it only carries Slack messages. Before retiring a
poll, list everything it triggered and give each non-Slack job its own durable scheduler
(system `cron`/`launchd`, or a scheduled routine) that survives the session. Subscribing to the
tail replaces only the *transport* (poll → push) and the *reply* path; keep your own state
(rules, per-thread memory).

## Gotchas & notes
- **Your own posts echo back** as `origin=hub` — filter them, don't act on them.
- **Blank-line keepalives** land on the stream every ~25s — skip them before
  parsing each line as JSON (see above; `jq` itself is unaffected, a raw
  `JSON.parse` per line is not). A lazily-created downstream log (`>>` on first write) can reintroduce the same "quiet vs.
  dead" ambiguity one layer up — `[ -s file ]` can't tell "no writes yet" from "file never
  created"; check existence and size separately if you gate on one.
- **Latency** ~1s; the stream carries new messages only. For history/catch-up use `/recent`
  (self-heals) or `/history` (explicit backfill, arbitrary `oldest`/`latest`); for a specific
  thread use `/thread` (it hydrates from Slack on demand).
- **Rolling store** (default 7-day retention) — it's short-term context, not an archive.
- **Coverage** is the user's view: channels the user is in. Not channels they haven't joined.
- Full API + deploy details: `README.md`.

## Minimal checklist
1. Get your channel id(s); confirm the user is a member.
2. Open a long-lived reader on `/tail?channels=…` (in Claude Code, a Monitor).
3. In your handler: ignore `origin=hub`; act on `human`/`peer`.
4. Reply with `/say` (in-thread via `thread_ts`); react with `/react`.
5. Pull `/thread` or `/context` when you need more than the one message.
