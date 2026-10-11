#!/usr/bin/env node
// slackline as an MCP server (stdio). Two modes, chosen by SLACKLINE_REMOTE:
//
//   local mode (default, SLACKLINE_REMOTE unset): holds a Slack socket in-process, stores to
//     SQLite (default) or memory, and exposes Slack tools to any MCP client (Claude Code,
//     Codex, etc). Optional real-time push into a Claude Code session via SLACKLINE_CHANNEL=1.
//
//     Credentials (pick one): SLACKLINE_XOXC + SLACKLINE_XOXD  |  SLACKLINE_TOKENS_FILE=/path/tokens.json
//       (user mode — sees everything the user does)  |  SLACKLINE_APP_TOKEN + SLACKLINE_BOT_TOKEN
//       (app mode — sees only channels the bot's been invited to; see README.md for the tradeoff)
//     Storage: SLACKLINE_STORE=sqlite|memory (default sqlite)
//
//   remote client mode (SLACKLINE_REMOTE=http://host:8790 set): a fleet of agents on other
//     hosts needs Slack access through a central slackline hub without each one opening its own
//     Slack connection with the same credentials. This process becomes a thin proxy — no store,
//     no resolveCreds, no startOrg, no Slack socket — every tool call is an HTTP request to the
//     hub (see remote.mjs). Config: SLACKLINE_REMOTE (hub base URL, required), SLACKLINE_SECRET
//     (x-slackline-secret header), SLACKLINE_ORG (default org; omit only if the hub serves one
//     org). Tool schemas are identical to local mode — an agent cannot tell which mode it's
//     attached to. Channel push (SLACKLINE_CHANNEL=1) works the same way, backed by one
//     long-lived GET /tail subscription per process instead of the local Slack socket.
//     SLACKLINE_ROUTES=1 takes the push channels from the machine's routing table for this
//     session's directory instead (agents/route.mjs, docs/agents.md) — one stream per
//     workspace, and none at all where nothing is routed. An explicit SLACKLINE_CHANNEL_ONLY
//     still wins, so existing registrations are unaffected.
import { defaultBlobDir } from './paths.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStore } from './db.mjs';
import { startOrg } from './ingest.mjs';
import { api, hydrateThread, hydrateAround, ensureNames, resolveUser, backfillChannel } from './slack.mjs';
import { transcript, channelLabel } from './render.mjs';
import { resolveCreds } from './creds.mjs';
import { badgeFor } from './badge.mjs';
import { saveFiles } from './bridges/core.mjs';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
// slack_app_status/slack_app_link below are thin wrappers over these — see app.mjs's file
// header. slack_app_create/init is deliberately NOT exposed as a tool: it shells out to the
// Slack CLI, can require a human to finish (team selection, or the App-Settings click-path when
// token capture degrades), and creates/installs a real Slack app — side effects an agent
// shouldn't trigger conversationally. status/link cover what's safe to automate. Neither is
// meaningful in remote mode (credential provisioning is the hub's job, not a proxy's), so
// they're only registered as tools in local mode — see TOOLS below.
import { status as appStatus, link as appLink } from './app.mjs';
import * as remote from './remote.mjs';
import { pushPlan, orgForChannel, sessionDir } from './agents/route.mjs';
import { openStreams } from './agents/streams.mjs';

const REMOTE = remote.remoteConfig();
// One session can listen in several workspaces, so remote mode cannot assume one.
// A tool call's workspace is chosen per channel: the routing table first, then a workspace
// this process has already been pushed a message from on that channel, then the configured
// default. Tool schemas are unchanged — the agent never names a workspace.
// A registration with an explicit SLACKLINE_CHANNEL_ONLY predates all this and behaves exactly
// as before: its configured workspace, never the table or the seen-map (a channel id is not
// always unique to one workspace, e.g. Slack Connect).
const seenOrg = new Map();
const LEGACY_ONLY = !!(process.env.SLACKLINE_CHANNEL_ONLY || '').trim();
const cfgFor = (channel) => (channel && !LEGACY_ONLY ? { ...REMOTE, org: orgForChannel(channel) || seenOrg.get(channel) || REMOTE.org } : REMOTE);
// A machine-wide registration (slackline agents install) must never become a local-mode server:
// that defaults to a sqlite store in the cwd, i.e. a slackline.db in every project directory a
// session starts in. With SLACKLINE_REMOTE_ONLY=1, no hub means stop — loudly, and before the
// store or the push directory is created.
if (!REMOTE && process.env.SLACKLINE_REMOTE_ONLY === '1') {
  process.stderr.write('slackline-mcp: FATAL: SLACKLINE_REMOTE_ONLY=1 but no hub is configured — set SLACKLINE_REMOTE or create ~/.slackline/config.json (docs/agents.md)\n');
  process.exit(1);
}

if (!REMOTE && !process.env.SLACKLINE_STORE && !process.env.DATABASE_URL) process.env.SLACKLINE_STORE = 'sqlite';
const BLOB = defaultBlobDir();
const PUSH = process.env.SLACKLINE_CHANNEL === '1';
// Restrict pushes to specific channel ids (comma-separated). Empty = every channel the account
// sees, which is the right default for a general context layer but wrong for a session that
// exists to serve one channel.
const ONLY = (process.env.SLACKLINE_CHANNEL_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const QA_DIR = process.env.SLACKLINE_QA_DIR || `${homedir()}/.slackline/qa`;
const log = (m) => process.stderr.write(`slackline-mcp: ${m}\n`);

if (PUSH) mkdirSync(process.env.SLACKLINE_QA_DIR || `${homedir()}/.slackline/qa`, { recursive: true });

// store/creds only exist in local mode — remote mode never touches db.mjs or creds.mjs at all,
// which is the whole point (no duplicate Slack connection per remote agent).
let store, creds, ORG;
if (REMOTE) {
  ORG = REMOTE.org || 'default';
} else {
  store = createStore(); await store.init();
  creds = await resolveCreds(store);
  // putToken's row shape is user-mode-only (token/cookie); an app credential has neither, so
  // only persist here for user mode (app credentials are persisted by whatever stored/resolved
  // them — resolveCreds — not re-derived here).
  if (creds && creds.mode !== 'app') await store.putToken(creds);
  ORG = creds ? creds.org : 'default';
}

const mcp = new Server(
  { name: 'slackline', version: '0.2.0' },
  { capabilities: { tools: {}, ...(PUSH ? { experimental: { 'claude/channel': {} } } : {}) },
    instructions: 'slackline exposes your Slack workspace. Use slack_recent/slack_context/slack_thread/slack_search to read, slack_history to backfill/browse further back than those have seen live, slack_say/slack_react to act.' +
      (PUSH ? ' New messages also arrive as <channel source="slackline"> events; react to human/peer, ignore origin=hub (your own posts).' : '') },
);
// The transport is deliberately NOT connected here — see the end of this file. Going live
// before the request handlers exist makes tools/list race their registration.

// Push a message into the session. Kept close to what the tmux bridge delivers, because the
// two are alternative transports for the same job and an agent shouldn't behave differently
// depending on which one is wired up.
async function pushToSession(rec) {
  const cn = await channelLabel(store, rec.org, rec.channel).catch(() => rec.channel);
  // A raw `U0EXAMPLE01:` tells the agent nothing about who is asking.
  const who = await resolveUser(store, rec.org, creds, rec.user).catch(() => null);
  const name = (who && (who.real_name || who.display_name || who.name)) || rec.user || '?';

  // Screenshots are the point for visual QA — a path the agent can open beats a URL it can't.
  const files = rec.files_json
    ? (typeof rec.files_json === 'string' ? JSON.parse(rec.files_json) : rec.files_json) : [];
  const saved = files.length ? await saveFiles(creds, files, QA_DIR, log) : [];

  const content = `${name}: ${rec.text || ''}`
    + (saved.length ? `\n[attachments saved locally: ${saved.map(f => f.path).join(', ')}]` : '');

  await mcp.notification({ method: 'notifications/claude/channel', params: {
    content,
    meta: { channel: rec.channel, channel_name: String(cn).replace(/[^A-Za-z0-9_]/g, ''),
      ts: rec.ts, thread_ts: rec.thread_ts || rec.ts, origin: rec.origin || 'peer',
      user: rec.user, user_name: name,
      ...(saved.length ? { files: saved.map(f => f.path) } : {}) } } }).catch(() => {});
}

// Remote-mode equivalent of pushToSession above: same job (ack + notify), sourced from one row
// of the hub's /tail instead of the local ingest publish callback. No Slack token here to fetch
// attachment bytes with (that's the whole point of remote mode), so files are named, not saved
// locally — see RemoteTail's construction below for the loop-guard/reconnect mechanics.
async function pushToSessionRemote(row, org) {
  seenOrg.set(row.channel, org);
  const files = row.files || [];
  const content = `${row.user_name || row.user || '?'}: ${row.text || ''}`
    + (files.length ? `\n[${files.length} attachment(s): ${files.map(f => f.name).join(', ')} — not downloaded in remote mode]` : '');
  await mcp.notification({ method: 'notifications/claude/channel', params: {
    content,
    meta: { org, channel: row.channel, channel_name: String(row.channel_name || row.channel).replace(/[^A-Za-z0-9_]/g, ''),
      ts: row.ts, thread_ts: row.thread_ts || row.ts, origin: row.origin || 'peer',
      user: row.user, user_name: row.user_name || row.user } } }).catch(() => {});
}

const need = () => { if (!REMOTE && !creds) throw new Error('slackline has no Slack credentials; set SLACKLINE_APP_TOKEN+SLACKLINE_BOT_TOKEN (app mode), or SLACKLINE_XOXC+SLACKLINE_XOXD / SLACKLINE_TOKENS_FILE (user mode)'); };
const text = (t) => ({ content: [{ type: 'text', text: t }] });
// not_in_channel is the single most likely real cause of "nothing stored" (app mode only sees
// channels the bot's been invited to) and is fixable by the operator in ten seconds — worth
// naming explicitly instead of folding into a generic empty-channel message.
const notInChannelMsg = (creds, channel) => `(no messages — slackline's ${creds.mode === 'app' ? 'bot' : 'account'} is not a member of channel ${channel}; invite it and try again)`;

// Model-facing: must stay accurate per mode, since an agent decides whether to pass no_badge
// (meaningless in app mode) based on this text. Remote mode can't know the hub's credential
// mode without an extra round trip, so it describes the (hub-enforced) badge behavior generically.
const SAY_DESC = REMOTE
  ? 'Post a message to a channel via the slackline hub (auto 🤖 badge unless no_badge, unless the hub credential is app mode). Reply in-thread with thread_ts.'
  : creds && creds.mode === 'app'
    ? 'Post a message as the bot (its own Slack identity — no_badge has no effect). Reply in-thread with thread_ts.'
    : 'Post a message as you (auto 🤖 badge unless no_badge). Reply in-thread with thread_ts.';

// Identical schemas in both modes (only descriptions/implementations differ) — an agent can't
// tell which mode it's attached to by inspecting the tool list.
const TOOLS = [
  { name: 'slack_whoami', description: 'Who slackline is authenticated as (auth.test).', inputSchema: { type: 'object', properties: {} } },
  { name: 'slack_recent', description: 'Recent messages in a channel, as a transcript. Self-heals: if nothing is stored yet it backfills one page from Slack first.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } },
  { name: 'slack_context', description: 'Context around a message: its thread (or a surrounding snippet) + participants.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' } }, required: ['channel', 'ts'] } },
  { name: 'slack_thread', description: 'Full thread for a parent ts (hydrates from Slack on demand).', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, thread_ts: { type: 'string' } }, required: ['channel', 'thread_ts'] } },
  { name: 'slack_history', description: 'Backfill a channel\'s history from Slack (conversations.history — no ts required, unlike slack_thread/slack_context) and return it as a transcript. Use this to browse backward past what slack_recent/slack_search have seen live. oldest/latest are Slack ts bounds for how far back to fetch.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' }, oldest: { type: 'string' }, latest: { type: 'string' } }, required: ['channel'] } },
  { name: 'slack_search', description: 'Text search over recently seen messages — a store scan only, never a live Slack API search (search.messages is not available to bot tokens). Use slack_history first if the channel predates what slackline has stored.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'slack_say', description: SAY_DESC, inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, thread_ts: { type: 'string' }, no_badge: { type: 'boolean' } }, required: ['channel', 'text'] } },
  { name: 'slack_react', description: 'Add an emoji reaction to a message.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' }, emoji: { type: 'string' } }, required: ['channel', 'ts', 'emoji'] } },
  // App-credential provisioning is the hub's job (it's the one holding Slack tokens) — these
  // two tools have no HTTP equivalent on the hub and are meaningless from a proxy, so they're
  // local-mode only.
  ...(REMOTE ? [] : [
    { name: 'slack_app_status', description: 'What Slack app credential is provisioned (app id, team, bot user, token presence). Never returns token values.', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
    { name: 'slack_app_link', description: 'Attach an existing Slack app by its tokens (from api.slack.com/apps): verifies bot identity via auth.test, then persists. Never echoes the tokens back.', inputSchema: { type: 'object', properties: { app_token: { type: 'string', description: 'xapp-… app-level token' }, bot_token: { type: 'string', description: 'xoxb-… bot token' }, org: { type: 'string' } }, required: ['app_token', 'bot_token'] } },
  ]),
];
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {};
  try {
    // Remote mode: every tool is an HTTP call to the hub (remote.mjs). A thrown Error here —
    // network failure or a non-2xx hub response — falls through to the catch below and becomes
    // an MCP isError result carrying the hub's status + error body, never a silent empty success.
    if (REMOTE) {
      switch (req.params.name) {
        case 'slack_whoami': return text(await remote.whoami(REMOTE));
        case 'slack_recent': return text(await remote.recent(cfgFor(a.channel), a));
        case 'slack_context': return text(await remote.context(cfgFor(a.channel), a));
        case 'slack_thread': return text(await remote.thread(cfgFor(a.channel), a));
        case 'slack_history': return text(await remote.history(cfgFor(a.channel), a));
        case 'slack_search': return text(await remote.search(REMOTE, a));
        case 'slack_say': return text(await remote.say(cfgFor(a.channel), a));
        case 'slack_react': return text(await remote.react(cfgFor(a.channel), a));
        default: return text('unknown tool');
      }
    }
    switch (req.params.name) {
      case 'slack_whoami': { need(); const w = await api(creds, 'auth.test'); return text(w.ok ? `${w.user} (${w.user_id}) @ ${w.url}` : 'error: ' + w.error); }
      case 'slack_recent': { need();
        const limit = Math.min(a.limit || 20, 100);
        let rows = await store.recent(ORG, a.channel, limit);
        // Self-heal: the rolling store only ever fills from live traffic, so a channel slackline
        // hasn't seen anything on yet would answer "(nothing stored yet...)" even though the
        // messages plainly exist in Slack and the account can see them. One backfilled page
        // (see slack.mjs's backfillChannel) turns that into a real answer instead of a dead end.
        if (!rows.length) {
          const bf = await backfillChannel(store, ORG, creds, a.channel, { limit, pages: 1, blobRoot: BLOB }).catch(() => null);
          if (bf && bf.error === 'not_in_channel') return text(notInChannelMsg(creds, a.channel));
          rows = await store.recent(ORG, a.channel, limit);
          if (!rows.length) return text(bf && !bf.error ? '(channel has no messages)' : '(nothing stored yet for this channel — new messages stream in live)');
        }
        await ensureNames(store, ORG, creds, rows);
        return text(await transcript(store, ORG, rows) || '(nothing stored yet for this channel — new messages stream in live)'); }
      case 'slack_thread': { need(); await hydrateThread(store, ORG, creds, a.channel, a.thread_ts, BLOB).catch(() => {}); const rows = await store.thread(ORG, a.channel, a.thread_ts); await ensureNames(store, ORG, creds, rows); return text(await transcript(store, ORG, rows) || '(thread not found)'); }
      case 'slack_history': { need();
        const limit = Math.min(a.limit || 100, 500);
        const bf = await backfillChannel(store, ORG, creds, a.channel, { limit, oldest: a.oldest, latest: a.latest, pages: 5, blobRoot: BLOB });
        if (bf.error) return text(bf.error === 'not_in_channel' ? notInChannelMsg(creds, a.channel) : 'error: ' + bf.error);
        await ensureNames(store, ORG, creds, bf.messages);
        const more = bf.has_more ? `\n(more available further back — pass oldest="${bf.oldest_ts}" to continue)` : '';
        return text((await transcript(store, ORG, bf.messages) || '(no messages in that range)') + more); }
      case 'slack_context': { need();
        let t = await store.getMessage(ORG, a.channel, a.ts);
        if (!t) { await hydrateAround(store, ORG, creds, a.channel, a.ts).catch(() => {}); t = await store.getMessage(ORG, a.channel, a.ts); }
        const root = t ? t.thread_ts : a.ts;
        await hydrateThread(store, ORG, creds, a.channel, root, BLOB).catch(() => {});
        let rows = await store.thread(ORG, a.channel, root);
        if (rows.length <= 1) rows = await store.around(ORG, a.channel, a.ts, 6, 3);
        await ensureNames(store, ORG, creds, rows);
        return text(`channel ${await channelLabel(store, ORG, a.channel)}\n` + (await transcript(store, ORG, rows) || '(no context)')); }
      case 'slack_search': { need(); const rows = await store.search(ORG, a.query, Math.min(a.limit || 20, 100)); await ensureNames(store, ORG, creds, rows); return text(await transcript(store, ORG, rows) || '(no matches in the rolling store)'); }
      case 'slack_say': { need();
        const body = badgeFor(creds, a.text, a.no_badge);
        const p = { channel: a.channel, text: body }; if (a.thread_ts) p.thread_ts = a.thread_ts;
        const r = await api(creds, 'chat.postMessage', p);
        if (r.ok) await store.putOutbound(ORG, a.channel, r.ts);
        return text(r.ok ? `posted ts=${r.ts}` : 'error: ' + r.error); }
      case 'slack_react': { need(); const r = await api(creds, 'reactions.add', { channel: a.channel, timestamp: a.ts, name: (a.emoji || '').replace(/:/g, '') }); return text(r.ok ? 'reacted' : 'error: ' + r.error); }
      // No need() here — the whole point of these two tools is bootstrapping app creds when
      // `need()` would otherwise be failing every other tool call.
      case 'slack_app_status': return text(JSON.stringify(await appStatus(store, a.org), null, 2));
      case 'slack_app_link': return text(JSON.stringify(await appLink(store, { org: a.org, appToken: a.app_token, botToken: a.bot_token }), null, 2));
      default: return text('unknown tool');
    }
  } catch (e) { return { isError: true, content: [{ type: 'text', text: 'error: ' + e.message }] }; }
});

// Connect the transport only AFTER every request handler above is registered. The MCP SDK
// answers -32601 "Method not found" for any method with no handler yet, and Claude Code sends
// tools/list immediately after initialize — so a transport that goes live earlier is racing
// the registrations. With push enabled the race is not theoretical: `await tail.connect()`
// must not sit between the two: a hub one network round trip away loses the race every
// time. The symptom was "Failed to fetch tools: Method not found" while the connection itself
// reported healthy — which reads like a capability or protocol-negotiation problem and is not
// one. Ordering is the whole fix: handlers, then transport, then start pushing.
await mcp.connect(new StdioServerTransport());
// Exit when the client goes away. An open push stream keeps the event loop alive after stdin
// ends, and with a machine-wide registration every finished session would otherwise leave an
// MCP server behind until the next pushed message hit EPIPE.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

if (REMOTE) {
  if (PUSH) {
    // Which streams to open is agents/route.mjs's decision table: an explicit
    // SLACKLINE_CHANNEL_ONLY, the routing table for this directory, or everything.
    const streams = pushPlan(process.env, sessionDir(process.env), { defaultOrg: REMOTE.org });
    const routed = process.env.SLACKLINE_ROUTES === '1' && !LEGACY_ONLY;
    // Routed registration: the streams come from a machine-wide table the operator edits, so a
    // wrong workspace or a hub that is down must never take the tools down with it. openStreams
    // retries a hub that is unreachable and gives up, with a log line, on one the hub refuses.
    if (routed) openStreams({ cfg: REMOTE, streams, log,
      onRow: (row, org) => pushToSessionRemote(row, org).catch(e => log(`push failed: ${e.message}`)) });
    else for (const s of streams) {
      const tail = new remote.RemoteTail({ ...REMOTE, org: s.org }, { channels: s.channels, log,
        onMessage: (row) => {
          if (row.origin === 'hub') return;   // defense in depth — the /tail subscription already asks the hub to drop these
          pushToSessionRemote(row, s.org).catch(e => log(`push failed: ${e.message}`));
        } });
      // Awaited: an unreachable/unauthorized hub must fail loudly right here, not disappear into
      // RemoteTail's background reconnect loop while the agent believes it's connected.
      try { await tail.connect(); }
      catch (e) { log(`FATAL: ${e.message}`); process.exit(1); }
    }
    log(streams.length
      ? `push streams: ${streams.map(s => `${s.org || '(default)'}:${s.channels.join(',') || 'all channels'}`).join(' ')}`
      : 'no channels routed for this directory — tools only, no push');
  }
  log(`remote mode: proxying to ${REMOTE.url}${REMOTE.org ? ` (org ${REMOTE.org})` : ''}; push=${PUSH}`);
} else if (creds) {
  // hold the socket + store; optionally push new messages into the session
  startOrg(store, creds, { hydrateThreads: true, blobRoot: BLOB, log,
    publish: (rec) => {
      if (!PUSH || rec.type) return;                 // push plain messages only
      // Without a filter the agent receives every channel the account can see. That is right
      // for a general context layer and wrong for a session dedicated to one channel.
      if (ONLY.length && !ONLY.includes(rec.channel)) return;
      pushToSession(rec).catch(e => log(`push failed: ${e.message}`));
    } });
  log(`connected as ${creds.user_id || creds.bot_user_id || '?'} (org ${ORG}); push=${PUSH}`);
} else log('no credentials — set SLACKLINE_APP_TOKEN+SLACKLINE_BOT_TOKEN (app mode), or SLACKLINE_XOXC+SLACKLINE_XOXD / SLACKLINE_TOKENS_FILE (user mode); tools will error until then');

log('mcp server ready');