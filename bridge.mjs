#!/usr/bin/env node
// Relay Slack messages from one channel into an agent, via one of four selectable delivery
// modes, and ack them. The shared behavior lives in bridges/core.mjs and must not regress;
// only DELIVERY differs by mode (bridges/tmux.mjs, headless.mjs, channels.mjs).
//
//   SLACKLINE_APP_TOKEN / SLACKLINE_BOT_TOKEN   app creds (both required)
//   SLACKLINE_BRIDGE_CHANNEL                    channel id to watch (e.g. C0EXAMPLE01)
//   SLACKLINE_BRIDGE                            channels|tmux|headless|auto (default channels)
//   SLACKLINE_BRIDGE_TMUX                       tmux mode: session to inject into (e.g. demo)
//   SLACKLINE_BRIDGE_CONCURRENCY                headless mode: max concurrent `claude -p` (default 2)
//   SLACKLINE_QA_DIR                            where reports land (default ~/.slackline/qa)
//
// See docs/bridge.md for what each mode does and the exact `channels` launch invocation.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createStore } from './db.mjs';
import { resolveCreds } from './creds.mjs';
import { api } from './slack.mjs';
import { createBridge } from './bridges/core.mjs';
import { selectMode } from './bridges/select.mjs';
import * as tmuxMode from './bridges/tmux.mjs';
import * as headlessMode from './bridges/headless.mjs';
import * as channelsMode from './bridges/channels.mjs';

const MODES = { tmux: tmuxMode, headless: headlessMode, channels: channelsMode };

const CHANNEL = process.env.SLACKLINE_BRIDGE_CHANNEL;
const QA_DIR = process.env.SLACKLINE_QA_DIR || `${homedir()}/.slackline/qa`;
const log = (m) => console.log(`[bridge] ${new Date().toISOString().slice(11, 19)} ${m}`);

if (!CHANNEL) {
  console.error('set SLACKLINE_BRIDGE_CHANNEL (channel id)');
  process.exit(1);
}

let mode;
try { mode = await selectMode(process.env.SLACKLINE_BRIDGE, MODES, log); }
catch (e) { console.error(e.message); process.exit(1); }

let delivery;
try { delivery = mode.init({ channel: CHANNEL, log }); }
catch (e) { console.error(e.message); process.exit(1); }

// channels mode is advisory only (see bridges/channels.mjs) — nothing to relay, so exit before
// touching credentials or making any live Slack call at all.
if (delivery.skipIngest) process.exit(0);

// Only default the store when NEITHER is set. createStore() prefers SLACKLINE_STORE over
// DATABASE_URL, so defaulting it unconditionally silently overrode an operator-supplied
// DATABASE_URL and pointed the bridge at an empty local sqlite — the same bug that made
// scripts/slack-reply.mjs report "no usable Slack credentials" against a store that plainly
// held a working credential.
if (!process.env.SLACKLINE_STORE && !process.env.DATABASE_URL) {
  process.env.SLACKLINE_STORE = 'sqlite:' + `${homedir()}/.slackline/bridge.db`;
}
mkdirSync(QA_DIR, { recursive: true });
mkdirSync(`${homedir()}/.slackline`, { recursive: true });

const store = createStore(); await store.init();
const creds = await resolveCreds(store);
if (!creds) { console.error('no usable credentials (app identity could not be verified)'); process.exit(1); }
if (creds.mode !== 'app') log('WARNING: running in user mode — the bridge expects an app credential');

// Resolved once: the agent should see a channel NAME, not a raw id it can do nothing with.
const channelName = await api(creds, 'conversations.info', { channel: CHANNEL })
  .then(r => (r.ok && r.channel ? '#' + r.channel.name : CHANNEL)).catch(() => CHANNEL);

log(`connected as ${creds.bot_user_id || creds.user_id} in ${creds.team_name}; watching ${channelName} (${CHANNEL}) -> ${delivery.label}`);

const bridge = createBridge({ store, creds, channel: CHANNEL, channelName, qaDir: QA_DIR, log, deliver: delivery.deliver });
bridge.start();
await bridge.backfill().catch(e => log(`backfill failed: ${e.message}`));
log('watching — Ctrl+C to stop');
