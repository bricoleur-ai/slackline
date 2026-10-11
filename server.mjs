// API service: serves /tail /query /context /say /file etc. Reads Postgres and
// LISTENs for events published by ingestd, fanning them to tail clients. Safe to
// redeploy anytime — the Slack connection lives in ingestd, not here.
import { defaultBlobDir } from './paths.mjs';
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { createStore } from './db.mjs';
import { startApi } from './api.mjs';
import { ensureBotIdentity } from './creds.mjs';

const DB = process.env.DATABASE_URL || (() => {
  throw new Error(
    'DATABASE_URL is not set. Either set it (postgres://user:pass@host:5432/db), ' +
    'or use the bundled SQLite store with SLACKLINE_STORE=sqlite, which needs no server.'
  );
})();
const PORT = +(process.env.SLACKLINE_PORT || 8790);
const SECRET = process.env.SLACKLINE_SECRET || '';
if (!SECRET) console.warn('⚠  SLACKLINE_SECRET is empty — API routes are UNPROTECTED except from loopback. Set it in .env.');
const SLACKLINE_RETAIN_DAYS = +(process.env.SLACKLINE_RETAIN_DAYS || 7);
const BLOB = defaultBlobDir();

const store = createStore(DB);
await store.init();
// self-heal: any message that was posted via /say (in the durable outbound table) is a hub post.
await store.reconcileOutbound().catch(() => {});  // reconcile origin

const bus = new EventEmitter(); bus.setMaxListeners(0);
bus.on('log', (m) => console.log(new Date().toISOString().slice(11, 19), m));

const credsMap = new Map();
const loadCreds = (t) => credsMap.set(t.org, { org: t.org, token: t.token, cookie: t.cookie, user_id: t.user_id, team_name: t.team_name });

// server.mjs needs its own credsMap too — /say, /react, and on-demand /thread + /context
// hydration all read from it directly (ingestd.mjs holding the socket doesn't help those
// routes). Mirror ingestd.mjs/standalone.mjs's app-over-user precedence: app credentials carry
// a verified bot identity (ensureBotIdentity fails closed) rather than an impersonated browser
// session, so start apps first and let the token loop below know which orgs to skip.
const appOrgs = new Set();
// Idempotent (skips any org already in appOrgs) so it also serves as the refresh path for a
// `POST /apps` credential provisioned after boot: /say, /react, /thread, /context would
// otherwise keep reading a credsMap frozen at startup and never see the new org.
async function loadNewApps() {
  for (const a of await store.listApps()) {
    if (appOrgs.has(a.org)) continue;
    const creds = await ensureBotIdentity({ ...a, mode: 'app' });
    if (!creds) { bus.emit('log', `skipping app credential for org ${a.org}: bot identity could not be verified`); continue; }
    appOrgs.add(creds.org);
    credsMap.set(creds.org, creds);   // overwrites any user-token entry already cached for this org
  }
}
await loadNewApps();
for (const t of await store.getTokens()) {
  if (appOrgs.has(t.org)) { bus.emit('log', `skipping user token for org ${t.org}: app credential already active for this org`); continue; }
  loadCreds(t);
}

// LISTEN for ingestd's published events; reconstruct full events, fan out to tail clients.
async function startListener() {
  const lis = new pg.Client({ connectionString: DB });
  lis.on('error', (e) => { bus.emit('log', `LISTEN error ${e.message} — resubscribing`); setTimeout(startListener, 1000); });
  await lis.connect();
  await lis.query('LISTEN slackline');
  lis.on('notification', async (n) => {
    if (n.channel !== 'slackline') return;
    let e; try { e = JSON.parse(n.payload); } catch { return; }
    if (e.k === 'm')   { const row = await store.getMessage(e.org, e.channel, e.ts); if (row) bus.emit('event', row); }
    else if (e.k === 'del') bus.emit('event', { org: e.org, channel: e.channel, ts: e.ts, type: 'message_deleted', time: e.time });
    else if (e.k === 'ed')  { const row = await store.getMessage(e.org, e.channel, e.ts); bus.emit('event', { org: e.org, channel: e.channel, ts: e.ts, type: 'message_edited', text: row ? row.text : '', time: e.time }); }
    else if (e.k === 'rx')  bus.emit('event', { org: e.org, channel: e.channel, ts: e.ts, type: e.added ? 'reaction_added' : 'reaction_removed', emoji: e.emoji, user: e.user, time: e.time });
  });
  bus.emit('log', 'listening for ingestd events');
}
await startListener();

// token push: cache creds for /say + tell ingestd (over NOTIFY) to connect that org.
const ctl = new pg.Client({ connectionString: DB }); await ctl.connect();
function onToken(t) {
  // Guard against a live token push reversing the app-over-user precedence decided above —
  // same rationale as standalone.mjs's onToken guard: without this, a pushed token for an org
  // already running under a verified app credential would silently overwrite this host's
  // credsMap entry (used by /say, /react, /thread, /context) with an impersonated-session one.
  if (appOrgs.has(t.org)) return bus.emit('log', `ignoring token push for org ${t.org}: app credential already active for this org`);
  loadCreds(t); ctl.query("SELECT pg_notify('slackline_ctl', $1)", [t.org]).catch(() => {}); bus.emit('log', `token for ${t.org} -> notified ingestd`);
}

// app credential push: POST /apps already persisted it (api.mjs calls store.putApp() before
// this fires) — refresh credsMap immediately, and notify ingestd over the same channel/payload
// onToken above already uses so it starts the actual runner without waiting on its own poll.
function onApp(a) {
  loadNewApps().catch((e) => bus.emit('log', `app refresh failed: ${e.message}`));
  ctl.query("SELECT pg_notify('slackline_ctl', $1)", [a.org]).catch(() => {});
  bus.emit('log', `app credential for org ${a.org} -> notified ingestd`);
}

startApi(store, bus, credsMap, { port: PORT, secret: SECRET, onToken, onApp, blobRoot: BLOB });

setInterval(async () => { const n = await store.prune(SLACKLINE_RETAIN_DAYS * 86400e3).catch(() => 0); if (n) bus.emit('log', `pruned ${n} msgs`); }, 3600e3);
// This host doesn't already LISTEN on slackline_ctl (only ingestd's socket-holding needs
// near-instant pickup) — a simple poll is enough to keep credsMap from going stale.
setInterval(() => loadNewApps().catch((e) => bus.emit('log', `app refresh failed: ${e.message}`)), 30000);
bus.emit('log', `slackline api up. db=${DB.replace(/:[^:@/]*@/, ':***@')} retain=${SLACKLINE_RETAIN_DAYS}d orgs=${credsMap.size}`);
