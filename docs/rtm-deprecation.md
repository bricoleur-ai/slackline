# RTM deprecation risk: what's actually true, and what to do about it

slackline's original and still-primary mode authenticates as a human user (a session token,
`xoxc-…`, plus the `d` cookie — see `slack.mjs`) and holds its realtime connection via
**`rtm.connect`** (`transports/rtm.mjs`). Slack is winding RTM down. This doc separates what
Slack has actually said from what we're inferring, states the risk honestly, and gives the
concrete migration path — which already exists in this codebase as **app mode over Socket
Mode** (`transports/socket.mjs`).

Researched 2026-08-23 against docs.slack.dev / api.slack.com. Re-check before trusting the dates
below if you're reading this much later — Slack has changed this timeline twice already.

## The headline finding: the shutdown slackline was worried about is currently paused

The often-cited date is **November 16, 2026** for classic apps. That date is real, but it is
**not currently in effect**. Timeline, from Slack's own changelog:

| Date | What happened | Source |
|---|---|---|
| 2024-09-30 | Announced: legacy custom bots stop **2025-03-31**; classic apps stop **2026 (date TBD, adjusted several times)** | [docs.slack.dev changelog, 2024-09-30](https://docs.slack.dev/changelog/2024-09-legacy-custom-bots-classic-apps-deprecation/) |
| 2025-03-31 | Legacy custom bots deprecation **took effect as scheduled** — this one was not paused | same page, "What's changing" |
| 2025-07-29 | Classic apps date pushed to **November 16, 2026** | [docs.slack.dev changelog, 2025-07-29](https://docs.slack.dev/changelog/2025/07/29/classic-apps-extension/) |
| 2025-12-08 | Classic apps deprecation **paused** — "we have decided to pause this migration" | [docs.slack.dev changelog, 2025-12-08](https://docs.slack.dev/changelog/2025/12/08/classic-apps-deprecation-paused/) |

The original 2024-09-30 announcement page has since been edited in place and, as fetched today,
now reads: **"Classic apps are not impacted at this time and will continue to work."** No later
changelog entry (checked through the current 2026 entries) reverses that pause. So: **the
November 16, 2026 hard-stop is not currently scheduled to happen.** It could be un-paused at any
time with the same lack of notice it was paused with — this is documented as paused, not
cancelled — but "under three months from now" is not the correct urgency level as of this
writing.

**This does not make the underlying risk zero**, for two reasons covered below: (1) the classic
apps deprecation was never actually the thing that named slackline's mode, and (2) rtm.connect
for user tokens is undocumented and has already been narrowed once (legacy custom bots, which
did ship on schedule).

## Is slackline's user mode actually in scope of any of this?

**No — not directly, and this is documented, not inferred.** Read closely, every one of Slack's
deprecation announcements is scoped to **apps and bots**, not to user identity:

- The 2024-09-30 announcement is titled "Discontinuing support for legacy **custom bots** and
  **classic apps**." Its own "How do I tell if my app will be impacted?" section only talks about
  checking your workspace's app/bot list — there is no user-token equivalent.
- The one explicit RTM statement in that page is: *"Slack apps do not support the legacy RTM
  API. If your legacy custom bot was using the legacy RTM API, you will need to configure it to
  use the Events API instead."* — again, scoped to apps/bots.
- The current `rtm.connect` method reference
  ([docs.slack.dev/reference/methods/rtm.connect](https://docs.slack.dev/reference/methods/rtm.connect/))
  says: *"New Slack apps may not use any Real Time Messaging API method. For most applications,
  Socket Mode is a better way to communicate with Slack anyway."* — again, "apps."
- Neither `docs.slack.dev/authentication/tokens` nor `api.slack.com/authentication/token-types`
  mentions `xoxc-` session tokens **at all**. They aren't a documented token type; they're the
  browser client's internal credential. Slack has never published a compatibility statement
  about them, positive or negative, with respect to RTM or anything else.

So: slackline's `xoxc-` + `d`-cookie mode is not a classic app, not a legacy custom bot, and not
named in any deprecation notice. It is simply **outside the documented product surface
entirely** — it works because it's what the Slack web client itself uses, not because Slack
published a contract for it.

## What about `xoxp-` (granular user tokens) specifically?

No distinct statement exists. Slack documents `xoxp-` tokens generally (they "represent
workspace members" and can call Web API methods the user could perform), but **nowhere states
whether a modern granular-scope `xoxp-` token may call `rtm.connect`**, and the "new Slack apps
may not use any RTM API method" line does not clarify whether a bare user token even counts as
belonging to "an app" for this purpose. This is a genuine documentation gap, not a resolved
question — do not treat either direction (allowed / not allowed) as confirmed for `xoxp-`.
`xoxc-` (what slackline actually uses) is a different, wholly undocumented token family — the
`xoxp-` question doesn't resolve slackline's exposure either way.

## Is there an officially supported realtime path for a user token today?

**No.** Every currently-supported realtime mechanism — Events API (HTTP) and Socket Mode — is
built around an **installed Slack app with a bot identity**: you subscribe to events for a bot,
not for a user. There is no documented "subscribe to everything this user can see" push
mechanism. This has been true throughout the RTM deprecation process; it isn't new. Coverage-wise
this matters: it's the reason app mode is *narrower*, not just *different* (see trade-off table
below).

## What Slack does say, unambiguously

- `rtm.connect` already rejects modern bot tokens with `not_allowed_token_type` (confirmed both
  by community reports, e.g.
  [slackapi/node-slack-sdk#921](https://github.com/slackapi/node-slack-sdk/issues/921) — labeled
  here as a **community source**, not official — and by this project's own testing:
  `apps.connections.open` and `rtm.connect` both reject bot-style tokens outright). RTM as a
  *bot* transport is functionally dead already; only the user-token question is open.
- `rtm.connect`'s own documented error table includes `deprecated_endpoint` ("The endpoint has
  been deprecated") and `method_deprecated` ("The method has been deprecated") as possible
  responses. These are Slack's built-in vocabulary for exactly the failure mode this doc is about
  — if the endpoint is withdrawn for user tokens, one of these two codes is the most likely shape
  it takes.

## Bottom line on exposure

| Question | Answer | Basis |
|---|---|---|
| Is the Nov 16 2026 classic-app shutdown currently in effect? | No — paused since 2025-12-08 | documented |
| Does any Slack deprecation notice name user/session tokens? | No | documented (absence, checked directly) |
| Does an officially supported user-token realtime path exist? | No | documented (absence) |
| Could `rtm.connect` for `xoxc-` be withdrawn without notice? | Possible, not scheduled | inferred — it's undocumented surface, and Slack has already narrowed RTM once (legacy bots, on schedule) |
| Is this urgent (weeks-to-months) as of 2026-08-23? | No | the concrete deadline that motivated urgency is paused |
| Is this a real, standing architectural risk? | Yes | undocumented dependency, no compatibility guarantee, one precedent of Slack narrowing this exact surface |

## How to tell if you're affected right now

`transports/rtm.mjs` now watches for the failure shapes above and logs a warning instead of
letting a withdrawal masquerade as routine reconnect noise:

- **Immediate warning** on `not_allowed_token_type`, `deprecated_endpoint`, or
  `method_deprecated` from `rtm.connect` — these error codes mean the endpoint/token type was
  rejected outright, not a transient hiccup.
- **Warning after 5 consecutive failures** on any other error (e.g. `invalid_auth`) without a
  single successful connect in between — ordinary session-token rotation recovers; a persistent
  run of failures does not.
- Re-announced at most every 30 minutes per org, so a long outage doesn't spam the log but also
  doesn't scroll off it.
- The warning **never changes retry behavior** — `rtm.mjs` still reports these as non-fatal so
  the ingest loop keeps retrying (session tokens are expected to rotate and recover; see the
  comment in `transports/rtm.mjs` and `ingest.mjs`'s reconnect/backoff). It is purely a log line
  telling a human to look.
- **No token value is ever logged** — only Slack's error code and the org name.

If you see this warning: check whether ordinary Web API calls (e.g. `slack_whoami`,
`conversations.list`) still succeed with the same credential. If Web API works but `rtm.connect`
does not, that isolates the failure to realtime specifically — the pattern this doc is about,
not a revoked/expired token (which breaks everything equally).

## Migration path: app mode (Socket Mode)

slackline already has this built as a fully working, additive third mode — it is not new work,
it's already-shipped mitigation. See `README.md` ("Or: a Slack app (bot), instead of a user
token") for the day-to-day setup; summarized here for the deprecation-response context:

1. Create a Slack app with Socket Mode enabled and obtain an app-level token (`xapp-…`) and a bot
   token (`xoxb-…`). The **documented, supported** way to do this is the "Generate Token and
   Scopes" flow on `api.slack.com/apps` or via `slack app install` / `slack run` from the
   [Slack CLI](https://docs.slack.dev). (The CLI can also yield an `xapp-` token through an
   *undocumented* code path, which `slackline app init` uses when it works; that path is
   treated as an optimization, not the supported contract, and the command falls back to manual
   steps when it fails. Use the documented UI flow if you want to depend only on documented
   behaviour.)
2. Set `SLACKLINE_APP_TOKEN=xapp-...` and `SLACKLINE_BOT_TOKEN=xoxb-...` (both required
   together — see `.env.example`). `creds.mjs`/`ingest.mjs` pick `transports/socket.mjs`
   automatically whenever `creds.mode === 'app'` (see `ingest.mjs:pickTransport`) — no RTM code
   path is touched.
3. Invite the bot to the channels it needs to see. App mode does **not** need `rtm.connect` at
   all — it uses `apps.connections.open` (Socket Mode), which is the actively-maintained, fully
   documented realtime path for apps and is unaffected by anything in this document.

### The trade-off — be honest about this, it is not a free migration

| | User-token mode (current) | App mode (migration target) |
|---|---|---|
| Sees | Every channel + DM the user is in | Only channels the bot is **invited to** |
| DMs | All of the user's DMs | Only DMs with the bot itself |
| Posts as | The human, with a 🤖 badge | The app's own bot identity, no badge |
| Setup | One browser sign-in | Create + install a Slack app, invite the bot per channel |
| Realtime transport | `rtm.connect` (undocumented for this token type) | `apps.connections.open` / Socket Mode (fully documented, actively maintained) |

Migrating to app mode trades **coverage** (seeing everything the user sees) for
**durability** (a supported, documented transport). For a workspace where slackline needs broad
passive visibility across many channels the operator doesn't control, this is a real loss, not a
formality — plan for re-inviting the bot to every channel that matters, and expect DM visibility
to disappear except where the bot itself is a DM participant.

## Recommendation

- **Do not treat this as an emergency migration today.** The specific deadline that would have
  forced it (2026-11-16) is currently paused, undocumented-forever is not the same claim as
  scheduled-for-shutdown, and user/session tokens were never named in any of Slack's own
  deprecation notices.
- **Do treat it as a standing architectural risk to monitor, not ignore.** `rtm.connect` for user
  tokens has no compatibility guarantee, Slack has already narrowed adjacent RTM access once on a
  hard schedule (legacy custom bots, March 2025, no pause), and the direction of travel across
  the whole product is unambiguous (Socket Mode/Events API for everything, RTM nowhere).
- **The mitigation is already built and costs nothing to keep available.** App mode requires no
  further engineering investment to exist as an escape hatch — it's shipped. The only remaining
  cost is *operational*: provisioning an app + bot token and accepting the coverage trade-off,
  which should happen if and when the warning logic above actually fires against a real
  workspace, not preemptively.
- **Re-check this document's Slack-side facts on a cadence** (e.g. whenever the warning fires, or
  every few months regardless) — the timeline has already moved twice in the last year, and
  "paused" is explicitly not "cancelled."
