// Bootstrap a session credential for light modes without the HTTP collector flow:
//   SLACKLINE_XOXC + SLACKLINE_XOXD   (token + d cookie)   [+ SLACKLINE_TEAM/ORG/USER]
//   SLACKLINE_TOKENS_FILE=/path/to/tokens.json  ({team,user,token,d} — the collector's format)
import { readFileSync, existsSync } from 'fs';
import { api } from './slack.mjs';

export function credsFromEnv() {
  const token = process.env.SLACKLINE_XOXC, cookie = process.env.SLACKLINE_XOXD;
  if (token && cookie) return { org: process.env.SLACKLINE_ORG || process.env.SLACKLINE_TEAM || 'default',
    team_name: process.env.SLACKLINE_TEAM || null, token, cookie, user_id: process.env.SLACKLINE_USER || null, mode: 'user' };
  const f = process.env.SLACKLINE_TOKENS_FILE;
  if (f && existsSync(f)) {
    try { const t = JSON.parse(readFileSync(f, 'utf8'));
      if (t.token && t.d) return { org: process.env.SLACKLINE_ORG || t.team || 'default', team_name: t.team || null, token: t.token, cookie: t.d, user_id: t.user || null, mode: 'user' };
    } catch {}
  }
  return null;
}
// Fill user_id via auth.test if missing (needed for own-message origin classification).
export async function ensureUserId(creds) {
  if (creds && !creds.user_id) { const w = await api(creds, 'auth.test').catch(() => null); if (w && w.ok) { creds.user_id = w.user_id; creds.team_name = creds.team_name || w.team; } }
  return creds;
}

// App (bot) credentials from env. Both tokens are required: the app-level token opens the
// Socket Mode connection, the bot token makes Web API calls. They are not interchangeable.
export function appCredsFromEnv() {
  const app_token = process.env.SLACKLINE_APP_TOKEN, bot_token = process.env.SLACKLINE_BOT_TOKEN;
  if (!app_token || !bot_token) return null;
  return { mode: 'app', org: process.env.SLACKLINE_ORG || 'default',
    app_token, bot_token, app_id: process.env.SLACKLINE_APP_ID || null,
    team_id: null, team_name: null, bot_user_id: null, bot_id: null };
}

// Fill org/bot identity from auth.test — bot_user_id and bot_id drive the app-mode loop guard.
// A failed/negative auth.test must NOT fall through to a half-built credential: with bot_id/
// bot_user_id left null, isSelfAuthored() in normalize.mjs can never match our own posts, and an
// agent reacting to the channel replies to itself forever against a live workspace. Failing to
// start is strictly better than starting degraded, so return null instead (fix round 1, finding 1).
// envSourced must be true ONLY for creds fresh from appCredsFromEnv() (resolveCreds' own env
// branch) — those have no stored partition key yet, so deriving org from auth.test's team name
// is safe. Store-sourced rows (resolveCreds' stored branch, and the listApps() loops in
// standalone.mjs/ingestd.mjs/server.mjs) MUST default to false and keep their stored org: those
// hosts read a row keyed by the OLD org, then compare it against user-token orgs to decide
// app-over-user precedence — rewriting org here (after the row was already read by that key)
// would desync the two, letting a user token for the same org slip past the skip check and
// double-ingest the workspace under two different partitions. Kept explicit (a parameter) rather
// than inferred, since both call paths otherwise look identical from inside this function.
export async function ensureBotIdentity(creds, envSourced = false) {
  if (!creds || creds.mode !== 'app' || creds.bot_id) return creds;   // non-app, or identity already known
  const w = await api(creds, 'auth.test').catch(() => null);
  if (!w || !w.ok) return null;   // could not verify bot identity — never start degraded
  creds.bot_user_id = w.user_id; creds.bot_id = w.bot_id;
  creds.team_id = w.team_id; creds.team_name = w.team;
  // w.team is the workspace DISPLAY NAME, which is mutable — an admin rename would silently
  // change the partition key on the next run. Kept for consistency with user mode; operators
  // running any store-backed deployment should pin SLACKLINE_ORG to avoid split records.
  if (envSourced && !process.env.SLACKLINE_ORG && creds.org === 'default') creds.org = w.team || 'default';
  return creds;
}

// Preference order: app creds from env, then a stored app credential, then user creds.
export async function resolveCreds(store) {
  const fromEnv = appCredsFromEnv();
  if (fromEnv) return await ensureBotIdentity(fromEnv, true);
  if (store && store.getApp) {
    const stored = await store.getApp(process.env.SLACKLINE_ORG || 'default').catch(() => null)
      || (store.listApps ? (await store.listApps().catch(() => []))[0] : null);
    if (stored) return await ensureBotIdentity({ ...stored, mode: 'app' });   // store-sourced: keep the stored org (envSourced=false)
  }
  return await ensureUserId(credsFromEnv());
}
