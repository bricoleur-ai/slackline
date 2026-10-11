#!/usr/bin/env node
// Lightweight single-process mode: ingest + API in one process, in-process fan-out,
// any storage backend (sqlite default). No Postgres/NOTIFY split. Good for one host.
//   SLACKLINE_STORE=sqlite|memory|postgres   SLACKLINE_SECRET=...   SLACKLINE_PORT=8790
import { defaultBlobDir } from './paths.mjs';
import { EventEmitter } from 'node:events';
import { createStore, backendName } from './db.mjs';
import { startOrg } from './ingest.mjs';
import { startApi } from './api.mjs';
import { credsFromEnv, ensureUserId, ensureBotIdentity } from './creds.mjs';

const PORT = +(process.env.SLACKLINE_PORT || 8790);
const SECRET = process.env.SLACKLINE_SECRET || '';
const RETAIN_DAYS = +(process.env.SLACKLINE_RETAIN_DAYS || 7);
const BLOB = defaultBlobDir();
if (!SECRET) console.warn('⚠  SLACKLINE_SECRET is empty — API routes are UNPROTECTED except from loopback.');

const store = createStore(); await store.init();
const bus = new EventEmitter(); bus.setMaxListeners(0);
bus.on('log', (m) => console.log(new Date().toISOString().slice(11, 19), m));

const credsMap = new Map(); const runners = new Map();
function start(t) {
  const creds = { org: t.org, token: t.token, cookie: t.cookie, user_id: t.user_id, team_name: t.team_name };
  credsMap.set(t.org, creds);
  if (runners.has(t.org)) runners.get(t.org).stop();
  runners.set(t.org, startOrg(store, creds, { hydrateThreads: true, blobRoot: BLOB,
    publish: (rec) => bus.emit('event', rec), log: (m) => bus.emit('log', m) }));
  bus.emit('log', `ingest started for org ${t.org}`);
}
function startApp(creds) {
  credsMap.set(creds.org, creds);
  if (runners.has(creds.org)) runners.get(creds.org).stop();
  runners.set(creds.org, startOrg(store, creds, { hydrateThreads: true, blobRoot: BLOB,
    publish: (rec) => bus.emit('event', rec), log: (m) => bus.emit('log', m) }));
  bus.emit('log', `ingest started for org ${creds.org} (app mode)`);
}

// standalone is multi-org (unlike mcp.mjs), so we can't use resolveCreds (single-credential,
// arbitrary-org fallback) here — instead mirror the existing per-token loop for the apps table.
// App credentials take precedence over a user token for the same org: they carry a verified
// bot identity (ensureBotIdentity fails closed) rather than an impersonated browser session,
// matching resolveCreds' own app-over-user precedence elsewhere in the codebase. Start apps
// first so the token loop below knows which orgs to skip.
const appOrgs = new Set();
// Re-scannable and idempotent (skips any org already in appOrgs) so it doubles as the refresh
// path for a `POST /apps` credential provisioned after boot — no restart needed to pick it up.
// Never starts a second runner for an org that already has one: startApp() itself stops any
// existing runner (token- or app-mode) for that org before starting the new one.
async function loadNewApps() {
  for (const a of await store.listApps()) {
    if (appOrgs.has(a.org)) continue;
    const creds = await ensureBotIdentity({ ...a, mode: 'app' });
    if (!creds) { bus.emit('log', `skipping app credential for org ${a.org}: bot identity could not be verified`); continue; }
    appOrgs.add(creds.org);
    startApp(creds);
  }
}
await loadNewApps();
for (const t of await store.getTokens()) {
  if (appOrgs.has(t.org)) { bus.emit('log', `skipping user token for org ${t.org}: app credential already active for this org`); continue; }
  start(t);
}
const envCreds = await ensureUserId(credsFromEnv());
if (envCreds && appOrgs.has(envCreds.org)) bus.emit('log', `skipping env-bootstrapped user org ${envCreds.org}: app credential already active for this org`);
else if (envCreds) { await store.putToken(envCreds); start(envCreds); bus.emit('log', `bootstrapped org ${envCreds.org} from env/file`); }

startApi(store, bus, credsMap, { port: PORT, secret: SECRET, blobRoot: BLOB,
  // Guard against a live token push reversing the app-over-user precedence decided above:
  // without this, a pushed token for an org already running under a verified app credential
  // would silently stop that runner and replace it with an impersonated-session one.
  onToken: async (t) => {
    if (appOrgs.has(t.org)) return bus.emit('log', `ignoring token push for org ${t.org}: app credential already active for this org`);
    start(await ensureUserId(t));
  },
  // POST /apps already persisted the credential (api.mjs's route calls store.putApp() before
  // this fires) — a full loadNewApps() re-scan picks it up immediately instead of waiting on
  // the 30s poll below. Optional per api.mjs's own comment: correct even if this were never
  // wired, since the poll is the backstop.
  onApp: () => { loadNewApps().catch((e) => bus.emit('log', `app refresh failed: ${e.message}`)); } });
setInterval(async () => { const n = await store.prune(RETAIN_DAYS * 86400e3).catch(() => 0); if (n) bus.emit('log', `pruned ${n}`); }, 3600e3);
// Any storage backend here (memory/sqlite/postgres), so LISTEN/NOTIFY isn't universally
// available — a plain poll is the one refresh mechanism that works on all of them.
setInterval(() => loadNewApps().catch((e) => bus.emit('log', `app refresh failed: ${e.message}`)), 30000);
bus.emit('log', `slackline standalone up. store=${backendName()} retain=${RETAIN_DAYS}d orgs=${credsMap.size} port=${PORT}`);
