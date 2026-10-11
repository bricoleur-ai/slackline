#!/usr/bin/env node
// Post a reply to the bridged Slack channel, as the app.
//
// This exists so an agent already running in a tmux session can answer a QA reporter WITHOUT
// restarting to pick up an MCP server — restarting would discard whatever it is mid-way through.
// It is deliberately tiny: read creds, post, print the ts.
//
//   node scripts/slack-reply.mjs --text "fixed it" [--thread 1787535687.693329] [--channel C…]
//
// Channel defaults to SLACKLINE_BRIDGE_CHANNEL. Credentials come from SLACKLINE_APP_TOKEN /
// SLACKLINE_BOT_TOKEN, or a stored app credential — the same resolution the bridge uses.
import { createStore } from '../db.mjs';
import { resolveCreds } from '../creds.mjs';
import { api } from '../slack.mjs';
import { homedir } from 'node:os';

function arg(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; }

const text = arg('--text');
const thread = arg('--thread');
const channel = arg('--channel') || process.env.SLACKLINE_BRIDGE_CHANNEL;

if (!text || !channel) {
  console.error('usage: slack-reply.mjs --text "..." [--thread <ts>] [--channel <id>]');
  console.error('  (channel falls back to SLACKLINE_BRIDGE_CHANNEL)');
  process.exit(1);
}

// Only fall back to the local bridge sqlite file when NEITHER is already set — db.mjs's
// createStore() itself prefers SLACKLINE_STORE over DATABASE_URL, so unconditionally defaulting
// SLACKLINE_STORE here (as this used to) silently overrode an operator-supplied DATABASE_URL,
// pointing this script at an empty local sqlite file instead of the real store. resolveCreds()
// would then find no app row and no env creds, and fail with "no usable Slack credentials" even
// though the same DATABASE_URL, used directly, demonstrably held a working app credential.
if (!process.env.SLACKLINE_STORE && !process.env.DATABASE_URL) {
  process.env.SLACKLINE_STORE = 'sqlite:' + `${homedir()}/.slackline/bridge.db`;
}
const store = createStore(); await store.init();
const creds = await resolveCreds(store);
if (!creds) { console.error('no usable Slack credentials'); process.exit(1); }

const p = { channel, text };
if (thread) p.thread_ts = thread;
const r = await api(creds, 'chat.postMessage', p);

if (!r.ok) { console.error('post failed:', r.error); process.exit(1); }
// Record it so the ingest loop classifies the echo as ours (origin=hub) and the bridge
// does not treat our own reply as a new QA report to relay back into the agent.
await store.putOutbound(creds.org, channel, r.ts).catch(() => {});
console.log('posted ts=' + r.ts);
