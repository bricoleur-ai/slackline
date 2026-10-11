// Slack app provisioning engine — the one implementation behind `slackline app <cmd>` (cli.mjs),
// the `slack_app_status`/`slack_app_link` MCP tools (mcp.mjs), and the `POST /apps` HTTP route
// (api.mjs). Those three surfaces must stay thin wrappers over the functions exported here.
//
// Closes a gap: putApp() existed in every store backend but had no
// production caller, so app mode only ever worked via mcp.mjs's env-var bootstrap. Every path
// below that obtains a credential ends at verifyAndPersist(), which calls store.putApp().
//
// SECURITY: nothing in this file may log, print, or return a raw token value. Functions that
// build a user-facing result object explicitly allowlist fields (never `...creds`) so a future
// edit can't accidentally leak one through JSON.stringify. Grep for `_token` before touching
// any return statement here.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { api } from './slack.mjs';
import { ensureBotIdentity } from './creds.mjs';
import { backendName } from './db.mjs';

const execFileP = promisify(execFileCb);

// ---- shell-out helper (dependency-injected everywhere it's used, so tests never spawn a real
// process) ----------------------------------------------------------------------------------
async function defaultRun(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: opts.timeout || 20000, cwd: opts.cwd, env: opts.env || process.env });
    return { code: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (e) {
    // execFile rejects on nonzero exit *and* on timeout/spawn failure; normalize to one shape
    // so callers never need a try/catch of their own.
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || e.message || 'command failed' };
  }
}
function slackBin(deps) { return deps.slackBin || process.env.SLACKLINE_SLACK_BIN || 'slack'; }

// ---- naming --------------------------------------------------------------------------------
export function sanitizeProjectName(name) {
  const s = String(name || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'project';
}
function channelNameFor(project) { return ('slackline-' + sanitizeProjectName(project)).slice(0, 80); }

// ---- manifest (translated to JSON; the CLI accepts either) ---------------
export function buildManifest(project) {
  const name = ('slackline-' + sanitizeProjectName(project)).slice(0, 35);   // Slack app display name cap
  return {
    display_information: { name },
    features: { bot_user: { display_name: name, always_online: true } },
    oauth_config: { scopes: { bot: [
      'channels:history', 'channels:read', 'channels:join', 'channels:manage',
      'groups:history', 'groups:read', 'im:history', 'im:read', 'mpim:history', 'mpim:read',
      'chat:write', 'reactions:read', 'reactions:write', 'users:read', 'files:read',
    ] } },
    settings: {
      event_subscriptions: { bot_events: [
        'message.channels', 'message.groups', 'message.im', 'message.mpim',
        'reaction_added', 'reaction_removed',
      ] },
      socket_mode_enabled: true, org_deploy_enabled: false, token_rotation_enabled: false,
    },
  };
}

// Writes the manifest in two places: `.slackline/manifest.json` is slackline's own record
// (everything slackline writes into the project tree lives under `.slackline/`);
// `manifest.json` at the project root is the copy `slack app install` actually needs — there is
// no `--manifest` flag, the CLI picks one up implicitly from the project
// directory it expects it in, which is the root.
export function writeManifest(cwd, manifest) {
  const dir = path.join(cwd, '.slackline');
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(path.join(dir, 'manifest.json'), json);
  writeFileSync(path.join(cwd, 'manifest.json'), json);
}

// ---- local secrecy policy: tokens written into the project tree live only under
// `.slackline/`, mode 0600, and `.slackline/app.json` is gitignored *before* it's written -----
export function ensureGitignoreEntry(cwd) {
  const gi = path.join(cwd, '.gitignore');
  const entry = '.slackline/app.json';
  let content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (content.split('\n').some((l) => l.trim() === entry)) return;
  if (content.length && !content.endsWith('\n')) content += '\n';
  writeFileSync(gi, content + entry + '\n');
}

function writeSecret0600(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}   // belt + suspenders: writeFileSync's mode is subject to umask
}

// Per-project credential copy — lets a project folder be the unit of "this is slackline-<x>'s
// app" (a per-project app identity) independent of which store backend a given host uses.
export function writeLocalAppFile(cwd, creds) {
  ensureGitignoreEntry(cwd);
  const file = path.join(cwd, '.slackline', 'app.json');
  writeSecret0600(file, creds);
  return file;
}

// Memory-mode stranding risk: the Slack app is permanent, memory-store creds are not.
// --persist mirrors to a location that survives a memory-store restart.
export function persistToHomeMirror(project, creds) {
  const file = path.join(homedir(), '.slackline', 'apps', sanitizeProjectName(project) + '.json');
  writeSecret0600(file, creds);
  return file;
}
export function warnIfMemoryWithoutPersist(persist, warn = (m) => console.warn(m)) {
  if (!persist && backendName() === 'memory') {
    warn('slackline app: SLACKLINE_STORE=memory and no --persist — this app credential will be ' +
      'LOST on restart. The Slack app itself is permanent in Slack; re-provisioning would be ' +
      'wasted work. Re-run with --persist to also mirror it to ~/.slackline/apps/<project>.json.');
  }
}

// ---- the one place every path funnels through: verify identity, then store.putApp() --------
// `partial` is whatever a caller has on hand: env vars, CLI flags, an HTTP POST body, or tokens
// captured from `slack run`. All of them are "fresh" credentials with no prior stored partition
// key, so envSourced=true is correct here — same reasoning creds.mjs documents for its own env
// branch: deriving org from auth.test's team name is only safe before anything was ever stored
// under the old org key.
export async function verifyAndPersist(store, partial, opts = {}) {
  if (!partial.app_token || !partial.bot_token) {
    const e = new Error('both an app-level token (xapp-...) and a bot token (xoxb-...) are required');
    e.code = 'missing_tokens';
    throw e;
  }
  const creds = { mode: 'app', org: partial.org || process.env.SLACKLINE_ORG || 'default',
    app_token: partial.app_token, bot_token: partial.bot_token,
    app_id: partial.app_id || null, team_id: partial.team_id || null, team_name: partial.team_name || null,
    bot_user_id: partial.bot_user_id || null, bot_id: partial.bot_id || null };
  const verified = await ensureBotIdentity(creds, true);
  if (!verified) {
    const e = new Error('could not verify bot identity (auth.test failed) — the token may be invalid or revoked');
    e.code = 'verify_failed';
    throw e;
  }
  await store.putApp(verified);
  if (opts.cwd) writeLocalAppFile(opts.cwd, verified);
  warnIfMemoryWithoutPersist(!!opts.persist, opts.warn);
  if (opts.persist) persistToHomeMirror(opts.project || verified.org, verified);
  return verified;
}

// ---- status: store read only, no network — cheap and safe to call often --------------------
export async function status(store, org) {
  const target = org || process.env.SLACKLINE_ORG || 'default';
  let row = await store.getApp(target).catch(() => null);
  if (!row && store.listApps) row = (await store.listApps().catch(() => []))[0] || null;
  if (!row) return { provisioned: false, org: target };
  return {
    provisioned: true, org: row.org, app_id: row.app_id || null, team_id: row.team_id || null,
    team_name: row.team_name || null, bot_user_id: row.bot_user_id || null, bot_id: row.bot_id || null,
    has_app_token: !!row.app_token, has_bot_token: !!row.bot_token,
  };
}

// ---- doctor: status + live checks (auth.test, apps.connections.open) -----------------------
export async function doctor(store, org) {
  const s = await status(store, org);
  const issues = [];
  const checks = { auth_test: null, socket_mode: null };
  if (!s.provisioned) {
    issues.push({ code: 'no_credentials', message: 'No app credential is provisioned. Run `slackline app init` or `slackline app link`.' });
    return { ok: false, org: s.org, issues, checks };
  }
  if (!s.has_app_token || !s.has_bot_token) {
    const missing = [!s.has_app_token && 'app token', !s.has_bot_token && 'bot token'].filter(Boolean).join(' and ');
    issues.push({ code: 'missing_tokens', message: `Missing ${missing}.` });
  }
  if (s.has_bot_token) {
    const row = await store.getApp(s.org);
    const creds = { mode: 'app', org: s.org, bot_token: row.bot_token, app_token: row.app_token };
    const w = await api(creds, 'auth.test').catch((e) => ({ ok: false, error: e.message }));
    checks.auth_test = w.ok ? 'ok' : (w.error || 'failed');
    if (!w.ok) {
      const revoked = w.error === 'invalid_auth' || w.error === 'token_revoked' || w.error === 'account_inactive';
      issues.push({ code: revoked ? 'revoked_token' : 'auth_test_failed', message: `auth.test failed: ${w.error}` });
    } else if (s.has_app_token) {
      const c = await api(creds, 'apps.connections.open').catch((e) => ({ ok: false, error: e.message }));
      checks.socket_mode = c.ok ? 'ok' : (c.error || 'failed');
      if (!c.ok) issues.push({ code: 'socket_mode_disabled', message: `apps.connections.open failed: ${c.error} — check the app's Socket Mode setting in App Settings.` });
    }
  }
  return { ok: issues.length === 0, org: s.org, issues, checks };
}

// ---- link: attach an existing app by tokens supplied directly ------------------------------
export async function link(store, opts = {}) {
  const verified = await verifyAndPersist(store,
    { org: opts.org || null, app_token: opts.appToken, bot_token: opts.botToken, app_id: opts.appId || null },
    { cwd: opts.cwd, persist: opts.persist, project: opts.project, warn: opts.warn });
  return { ok: true, org: verified.org, app_id: verified.app_id, team_id: verified.team_id,
    team_name: verified.team_name, bot_user_id: verified.bot_user_id, bot_id: verified.bot_id };
}

// ---- init: full provisioning sequence, degrading to a human click-path at the two
// steps that can require a person: token capture and (best-effort, non-fatal) channel setup ---

function degradeInstructions() {
  return [
    'Automatic token capture uses an undocumented Slack CLI path and is',
    'treated as an optimization, never the foundation. It did not succeed here — finish by hand:',
    '  1. https://api.slack.com/apps -> your app -> "Socket Mode" -> enable it if needed.',
    '  2. Same app -> "Basic Information" -> "App-Level Tokens" -> generate one with connections:write.',
    '  3. "OAuth & Permissions" -> install to workspace -> copy the Bot User OAuth Token (xoxb-...).',
    '  4. slackline app link --app-token xapp-... --bot-token xoxb-...',
  ].join('\n');
}

// Preflight: every command checks auth first; unauthenticated exits non-zero with the
// exact human command rather than hanging on a TTY prompt `slack auth login` would otherwise show.
export async function checkCliAuth(deps = {}) {
  const run = deps.run || defaultRun;
  const bin = slackBin(deps);
  const r = await run(bin, ['auth', 'list', '--json'], { cwd: deps.cwd });
  if (r.code !== 0) return { ok: false, message: 'Slack CLI is not authenticated.', humanCommand: `${bin} auth login` };
  let teams = [], parsedOk = true;
  try {
    const parsed = JSON.parse(r.stdout);
    teams = Array.isArray(parsed) ? parsed : Object.values(parsed && typeof parsed === 'object' ? parsed : {});
  } catch { parsedOk = false; }   // exited 0 but --json's shape shifted under us — still treat as authenticated
  if (parsedOk && teams.length === 0) {
    return { ok: false, message: 'Slack CLI has no authenticated teams.', humanCommand: `${bin} auth login` };
  }
  return { ok: true, teams };
}

export async function runSlackInstall(team, deps = {}) {
  const run = deps.run || defaultRun;
  const bin = slackBin(deps);
  const r = await run(bin, ['app', 'install', '--environment', 'local', '--team', team, '--no-prompt'], { cwd: deps.cwd, timeout: deps.installTimeoutMs || 60000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'slack app install failed').trim() };
  const m = /\bA[0-9A-Z]{8,}\b/.exec(r.stdout || '');   // App IDs are public identifiers, not secrets — safe to surface
  return { ok: true, appId: m ? m[0] : null };
}

const CAPTURE_SHIM_SRC = `// Auto-generated by "slackline app init" — captures the Socket Mode tokens \`slack run\`
// injects into this child process's environment (never written to disk by the CLI itself —
// see captureTokensViaCli below), writes them to the path on argv[2], and exits immediately.
// If you find this file at rest, init's cleanup step did not run; safe to delete by hand.
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
writeFileSync(out, JSON.stringify({
  app_token: process.env.SLACK_APP_TOKEN || process.env.SLACK_CLI_XAPP || null,
  bot_token: process.env.SLACK_BOT_TOKEN || process.env.SLACK_CLI_XOXB || null,
}));
process.exit(0);
`;

// Captures tokens via a ONE-SHOT `slack run`: the CLI's `get-hooks` protocol
// resolves "start" dynamically and silently overrides a hand-edited `.slack/hooks.json` entry
// (observed empirically), so instead of fighting that we swap the thing get-hooks derives a JS
// project's start command FROM — package.json's own "scripts.start" — restoring it in a
// `finally` no matter what happens. Tokens are stable across runs, so this only
// ever needs to succeed once; slackline never runs as a child of `slack run` again afterward.
// Returns null on ANY failure so the caller degrades cleanly — this path is an optimization,
// never the foundation.
export async function captureTokensViaCli(cwd, deps = {}) {
  const run = deps.run || defaultRun;
  const bin = slackBin(deps);
  const pkgPath = path.join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;   // not a CLI-native JS project layout — nothing to hook into

  const shimPath = path.join(cwd, '.slackline', 'capture-shim.mjs');
  const outPath = path.join(cwd, '.slackline', 'capture-tokens.json');
  const pkgRaw = readFileSync(pkgPath, 'utf8');
  let restoreNeeded = false;
  try {
    mkdirSync(path.dirname(shimPath), { recursive: true });
    writeFileSync(shimPath, CAPTURE_SHIM_SRC);
    const pkg = JSON.parse(pkgRaw);
    pkg.scripts = { ...pkg.scripts, start: `node ${JSON.stringify(shimPath)} ${JSON.stringify(outPath)}` };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    restoreNeeded = true;
    if (existsSync(outPath)) rmSync(outPath);
    await run(bin, ['run'], { cwd, timeout: deps.captureTimeoutMs || 25000 });
    if (!existsSync(outPath)) return null;
    const captured = JSON.parse(readFileSync(outPath, 'utf8'));
    return (captured.app_token && captured.bot_token) ? captured : null;
  } catch {
    return null;
  } finally {
    if (restoreNeeded) { try { writeFileSync(pkgPath, pkgRaw); } catch {} }
    try { rmSync(shimPath, { force: true }); } catch {}
    try { rmSync(outPath, { force: true }); } catch {}
  }
}

// Last step of init — best-effort, never fatal: the channel is a convenience, not a
// prerequisite for the credential being usable.
export async function createAndJoinChannel(creds, project) {
  const name = channelNameFor(project);
  let r = await api(creds, 'conversations.create', { name, is_private: 'false' });
  if (!r.ok && r.error === 'name_taken') {
    const list = await api(creds, 'conversations.list', { types: 'public_channel', limit: '200' });
    const found = list.ok ? (list.channels || []).find((c) => c.name === name) : null;
    r = found ? { ok: true, channel: found } : { ok: false, error: r.error };
  }
  if (!r.ok || !r.channel) return { ok: false, error: r.error || 'could not create or find the channel' };
  const channel = { id: r.channel.id, name: r.channel.name || name };
  const j = await api(creds, 'conversations.join', { channel: channel.id });
  if (!j.ok) return { ok: false, error: j.error, channel };
  return { ok: true, channel };
}

// deps is entirely for tests: { run, slackBin, installTimeoutMs, captureTimeoutMs }. Real
// callers (cli.mjs) never pass it — defaults shell out to the real `slack` binary.
export async function init(store, opts = {}, deps = {}) {
  const cwd = opts.cwd || process.cwd();
  const project = sanitizeProjectName(opts.project || path.basename(cwd));

  const auth = await checkCliAuth({ ...deps, cwd });
  if (!auth.ok) return { ok: false, step: 'auth', message: auth.message, humanCommand: auth.humanCommand };

  let team = opts.team || process.env.SLACK_TEAM || null;
  if (!team && auth.teams && auth.teams.length === 1) {
    const t = auth.teams[0];
    team = t.team_id || t.id || t.TeamID || t.team || null;
  }
  if (!team) return { ok: false, step: 'team', message: 'No team specified and none could be inferred from `slack auth list`. Pass --team <TEAM_ID>.' };

  writeManifest(cwd, buildManifest(project));

  const install = await runSlackInstall(team, { ...deps, cwd });
  if (!install.ok) return { ok: false, step: 'install', message: install.error, instructions: degradeInstructions() };

  const tokens = await captureTokensViaCli(cwd, deps);
  if (!tokens) {
    return { ok: false, degraded: true, step: 'capture', project, team, app_id: install.appId,
      message: 'Automatic token capture did not succeed.', instructions: degradeInstructions() };
  }

  let verified;
  try {
    verified = await verifyAndPersist(store,
      { org: opts.org || null, app_token: tokens.app_token, bot_token: tokens.bot_token, app_id: install.appId },
      { cwd, persist: opts.persist, project, warn: opts.warn });
  } catch (e) {
    return { ok: false, degraded: true, step: 'verify', project, team, app_id: install.appId,
      message: e.message, instructions: degradeInstructions() };
  }

  const channel = await createAndJoinChannel(verified, project).catch((e) => ({ ok: false, error: e.message }));
  return { ok: true, org: verified.org, app_id: verified.app_id, team_id: verified.team_id,
    team_name: verified.team_name, bot_user_id: verified.bot_user_id, bot_id: verified.bot_id,
    channel: channel.ok ? channel.channel : null,
    warnings: channel.ok ? [] : [`could not create/join the test channel: ${channel.error}`] };
}
