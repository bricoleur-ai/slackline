// Connection-holder: owns one Slack socket per org, writes to Postgres, and
// publishes compact events via Postgres NOTIFY. This process stays UP while the
// API redeploys — so feature deploys never drop the Slack connection or lose
// messages. Restart this only to change ingest itself.
import { defaultBlobDir } from './paths.mjs';
import pg from 'pg';
import { createStore } from './db.mjs';
import { startOrg } from './ingest.mjs';
import { ensureBotIdentity } from './creds.mjs';

const DB = process.env.DATABASE_URL || (() => {
  throw new Error(
    'DATABASE_URL is not set. Either set it (postgres://user:pass@host:5432/db), ' +
    'or use the bundled SQLite store with SLACKLINE_STORE=sqlite, which needs no server.'
  );
})();
const BLOB = defaultBlobDir();

const store = createStore(DB);
await store.init();
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

// dedicated connection for NOTIFY publishing + LISTEN on the control channel
const ctl = new pg.Client({ connectionString: DB });
await ctl.connect();

function envelope(rec) {
  if (rec.type === 'message_deleted') return { k: 'del', org: rec.org, channel: rec.channel, ts: rec.ts, time: rec.time };
  if (rec.type === 'message_edited')  return { k: 'ed',  org: rec.org, channel: rec.channel, ts: rec.ts, time: rec.time };
  if (rec.type === 'reaction_added' || rec.type === 'reaction_removed')
    return { k: 'rx', org: rec.org, channel: rec.channel, ts: rec.ts, emoji: rec.emoji, user: rec.user, added: rec.type === 'reaction_added', time: rec.time };
  return { k: 'm', org: rec.org, channel: rec.channel, ts: rec.ts };   // normal message: pointer, API fetches+shapes
}
const publish = (rec) => ctl.query("SELECT pg_notify('slackline', $1)", [JSON.stringify(envelope(rec))]).catch(() => {});

const runners = new Map();   // org -> {stop}
function startOrgFromToken(t) {
  const creds = { org: t.org, token: t.token, cookie: t.cookie, user_id: t.user_id, team_name: t.team_name };
  if (runners.has(t.org)) runners.get(t.org).stop();
  runners.set(t.org, startOrg(store, creds, { hydrateThreads: true, blobRoot: BLOB,
    publish, log }));
  log(`ingest started for org ${t.org} (${t.team_name || ''})`);
}
function startOrgFromApp(creds) {
  if (runners.has(creds.org)) runners.get(creds.org).stop();
  runners.set(creds.org, startOrg(store, creds, { hydrateThreads: true, blobRoot: BLOB,
    publish, log }));
  log(`ingest started for org ${creds.org} (app mode, ${creds.team_name || ''})`);
}

// ingestd is multi-org (like standalone.mjs), so we iterate store.listApps() ourselves rather
// than call resolveCreds (single-credential, arbitrary-org fallback). App credentials take
// precedence over a user token for the same org — see standalone.mjs for the full rationale
// (verified bot identity vs. an impersonated browser session; matches resolveCreds' own
// app-over-user precedence). Start apps first so the token loop knows which orgs to skip.
const appOrgs = new Set();
// Starts org's runner in app mode iff an app credential now exists for it and it isn't already
// running under one — the one gate that also makes this idempotent, so it's reusable both for
// the boot-time scan and for a refresh triggered later (a `POST /apps` credential provisioned
// after boot must be picked up without restarting this process). startOrgFromApp() itself stops
// any existing runner (token- or app-mode) for the org first, so this never leaves two runners
// racing on the same workspace.
async function tryStartApp(org) {
  if (appOrgs.has(org)) return true;
  const a = await store.getApp(org);
  if (!a) return false;
  const creds = await ensureBotIdentity({ ...a, mode: 'app' });
  if (!creds) { log(`skipping app credential for org ${org}: bot identity could not be verified`); return false; }
  appOrgs.add(creds.org);
  startOrgFromApp(creds);
  return true;
}
async function loadNewApps() {
  for (const a of await store.listApps()) await tryStartApp(a.org);
}
await loadNewApps();
for (const t of await store.getTokens()) {
  if (appOrgs.has(t.org)) { log(`skipping user token for org ${t.org}: app credential already active for this org`); continue; }
  startOrgFromToken(t);
}

// react to token pushes from the API (it NOTIFYs slackline_ctl with the org)
await ctl.query('LISTEN slackline_ctl');
ctl.on('notification', async (n) => {
  if (n.channel !== 'slackline_ctl') return;
  const org = n.payload;
  if (appOrgs.has(org)) return log(`ignoring token push for org ${org}: app credential already active for this org`);
  // The same channel/payload shape (org string) a freshly provisioned app credential would use
  // too — check the apps table before assuming this is a token push, so a brand-new org's very
  // first credential gets app-over-user precedence, not just a later token for an org that
  // already had an app. Falls through to the token lookup below when it isn't an app push.
  if (await tryStartApp(org)) return;
  const t = (await store.getTokens()).find((x) => x.org === org);
  if (t) startOrgFromToken(t);
});
// Backstop in case a provisioning route never NOTIFYs this channel (or NOTIFYs a different one)
// — guarantees pickup within one interval either way, on top of the near-instant NOTIFY path.
setInterval(() => loadNewApps().catch((e) => log(`app refresh failed: ${e.message}`)), 30000);

log(`slackline ingest up. db=${DB.replace(/:[^:@/]*@/, ':***@')} orgs=${runners.size}`);
