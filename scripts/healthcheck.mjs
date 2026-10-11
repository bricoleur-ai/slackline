#!/usr/bin/env node
// One command that answers "is the QA pipeline actually working right now?".
//
// Every check here corresponds to a way this system has actually broken or could break
// silently. Silence is the enemy: a reporter posting into a channel where nothing is listening
// looks identical, from their side, to one where everything works.
//
//   node scripts/healthcheck.mjs [--channel C…] [--tmux demo] [--json]
//
// Exit 0 = healthy, 1 = degraded (something needs attention).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createStore } from '../db.mjs';
import { api } from '../slack.mjs';
import { resolveCreds } from '../creds.mjs';
import { loadEnvFile } from '../envfile.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const JSON_OUT = process.argv.includes('--json');

// Look at exactly what the deployment uses, not a second, drifting copy of the configuration.
// Two topologies exist and they fail differently, so the check must know which one it is looking
// at. Reading the wrong one is the dangerous case: after the docker cutover this script happily
// reported a stale sqlite file as a healthy buffer while the real store was elsewhere.
const DEPLOY_DIR = process.env.SLACKLINE_DEPLOY_DIR || `${homedir()}/srv/slackline`;
const dockerDeploy = existsSync(`${DEPLOY_DIR}/docker-compose.yml`) && existsSync(`${DEPLOY_DIR}/.env`);
if (dockerDeploy) loadEnvFile(`${DEPLOY_DIR}/.env`); else loadEnvFile();

// The compose deploy talks to Postgres; point the store lookup at it rather than a leftover file.
if (dockerDeploy && !process.env.DATABASE_URL) {
  const { PGUSER = 'slackline', PGPASSWORD = '', PGDATABASE = 'slackline', PG_EXPOSE = '5440' } = process.env;
  process.env.DATABASE_URL = `postgres://${PGUSER}:${PGPASSWORD}@127.0.0.1:${PG_EXPOSE}/${PGDATABASE}`;
  delete process.env.SLACKLINE_STORE;         // DATABASE_URL must win, not a stale sqlite path
}

const CHANNEL = arg('channel', process.env.SLACKLINE_BRIDGE_CHANNEL);
const SESSION = arg('tmux', process.env.SLACKLINE_BRIDGE_TMUX);
const results = [];
const ok   = (name, detail) => results.push({ name, state: 'ok', detail });
const warn = (name, detail) => results.push({ name, state: 'warn', detail });
const bad  = (name, detail) => results.push({ name, state: 'fail', detail });

// Some of these commands report status via EXIT CODE and still print the answer on stdout
// (`systemctl is-active` exits 3 when inactive). Throwing that output away turns a precise
// "inactive" into a vague "missing", so keep stdout even on a non-zero exit.
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); }
  catch (e) { const out = String(e.stdout || '').trim(); return out || null; }
};

// systemd is Linux-only; on macOS the service checks must degrade rather than report failure.
const hasSystemd = process.platform === 'linux' && !!sh('systemctl', ['--version']);

// Parse an env var as milliseconds, falling back to `def` when unset/blank/non-numeric.
const numOr = (v, def) => { if (v === undefined || v === '') return def; const n = Number(v); return Number.isFinite(n) ? n : def; };
const fmtAge = (ms) => { const m = ms / 60000; return m < 60 ? `${m.toFixed(0)}m` : `${(m / 60).toFixed(1)}h`; };
// docker prefixes every line with its OWN timestamp when --timestamps is passed, independent of
// whatever timestamp (if any) the app's message carries — that's the one to trust for "did this
// container write ANYTHING recently". Take the last match, not the first, in case the tail
// contains an older timestamp-shaped string inside a log message's text.
function newestLogTimestamp(text) {
  const stamps = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g);
  return stamps && stamps.length ? new Date(stamps[stamps.length - 1]).getTime() : null;
}
// ingest.mjs now emits a heartbeat line every SLACKLINE_HEARTBEAT_MS even when idle (see its
// startOrg) specifically so log RECENCY proves liveness, not just history. Threshold is a
// multiple of that interval — wide enough to absorb jitter/log-flush delay without weakening
// the signal into uselessness — overridable independently via SLACKLINE_HEALTHCHECK_STALE_MS.
const HEARTBEAT_MS = numOr(process.env.SLACKLINE_HEARTBEAT_MS, 5 * 60 * 1000);
const STALE_MS = numOr(process.env.SLACKLINE_HEALTHCHECK_STALE_MS, HEARTBEAT_MS > 0 ? HEARTBEAT_MS * 3 : 15 * 60 * 1000);

// 1. The ingest. If this is down, nothing is buffering and messages are being lost outright.
if (dockerDeploy) {
  const ps = sh('docker', ['compose', '--project-directory', DEPLOY_DIR, 'ps', '--format', '{{.Service}} {{.State}} {{.Health}}']) || '';
  const line = ps.split('\n').find(l => l.startsWith('ingest '));
  if (!line) bad('ingest', `no 'ingest' service in the compose stack at ${DEPLOY_DIR} — NOTHING is buffering`);
  else if (!/running/.test(line)) bad('ingest', `compose service is '${line.trim()}' — NOTHING is buffering Slack messages`);
  else if (/unhealthy/.test(line)) bad('ingest', 'container running but UNHEALTHY');
  else ok('ingest', `compose service running (${DEPLOY_DIR})`);
  const apiLine = ps.split('\n').find(l => l.startsWith('api '));
  if (apiLine && !/running/.test(apiLine)) bad('api', `compose service is '${apiLine.trim()}' — subscribers cannot reach the hub`);
  else if (apiLine) ok('api', 'compose service running');
} else if (hasSystemd) {
  const unit = sh('systemctl', ['--user', 'is-active', 'slackline-ingest.service']);
  if (unit === 'active') {
    const nrestarts = sh('systemctl', ['--user', 'show', 'slackline-ingest.service', '-p', 'NRestarts', '--value']);
    if (Number(nrestarts) > 3) warn('ingest daemon', `active but has restarted ${nrestarts}x — check the log`);
    else ok('ingest daemon', `active (restarts: ${nrestarts || 0})`);
  } else bad('ingest daemon', `systemd unit is '${unit || 'missing'}' — NOTHING is buffering Slack messages`);
} else {
  // No systemd (macOS, or a host running slackline under launchd/supervisor/by hand). Asking
  // `systemctl` there returns nothing, and reporting that as a hard failure would make a
  // perfectly healthy laptop deploy look dead — the opposite of this script's job. Fall back
  // to "is an ingest process running at all", which is the part that actually matters.
  const running = sh('pgrep', ['-f', 'ingestd\\.mjs']);
  if (running) ok('ingest daemon', `process running (pid ${running.split('\n')[0]}; no systemd on this host)`);
  else bad('ingest daemon', 'no ingestd.mjs process and no systemd unit — NOTHING is buffering Slack messages');
}

// 2. A live socket AND a live log. A running process with a dead socket still ingests
//    nothing — the silent-failure case this whole check exists for. But "does 'socket mode
//    open' appear anywhere in the tail" only proves a socket was opened AT SOME POINT — a
//    stale line from days ago matches exactly as well as a fresh one. That is precisely how a
//    Socket Mode connection wedged for ~2 days on one org (Aug 2026) went undetected: container
//    "running", RestartCount 0, log's last line "socket mode open", and this check kept
//    reporting healthy the entire time it delivered zero events. `log freshness` below checks
//    RECENCY of the log tail instead, which the heartbeat line ingest.mjs now emits on an
//    otherwise-idle connection is what keeps genuinely fresh.
if (dockerDeploy) {
  const logs = sh('docker', ['compose', '--project-directory', DEPLOY_DIR, 'logs', 'ingest', '--tail', '60', '--timestamps']) || '';
  const newest = newestLogTimestamp(logs);
  if (HEARTBEAT_MS <= 0) {
    // Heartbeat disabled: recency alone can't distinguish "wedged" from "quiet", so fall back
    // to the weaker history-only check this replaces.
    if (/socket mode open|rtm socket open/.test(logs)) warn('log freshness', 'SLACKLINE_HEARTBEAT_MS=0 — cannot verify the log is alive NOW, only that a socket opened at some point in the tail');
    else bad('log freshness', 'no "socket … open" line in the tail, and heartbeat is disabled — cannot tell whether ingest is alive');
  } else if (newest == null) {
    bad('log freshness', 'no timestamped log lines in the tail — cannot verify the ingest process is alive');
  } else {
    const ageMs = Date.now() - newest;
    if (ageMs > STALE_MS) bad('log freshness', `no log output in ${fmtAge(ageMs)} (threshold ${fmtAge(STALE_MS)}) — no heartbeat means the process is wedged or dead, not merely quiet`);
    else ok('log freshness', `log active ${fmtAge(ageMs)} ago (heartbeat every ${fmtAge(HEARTBEAT_MS)})`);
  }
  if (/socket mode open|rtm socket open/.test(logs)) {
    const orgs = (logs.match(/ingest started for org ([^\n(]+)/g) || []).length;
    ok('slack socket', `connected at some point in the recent log (${orgs || '?'} org runner(s) started) — see 'log freshness' for whether it still is`);
  } else warn('slack socket', 'no recent "socket … open" line in the ingest container log');
  // Match SLACK auth failures specifically. A bare /fatal/ also matches Postgres's own
  // `severity: 'FATAL'` on a transient 57P01 (admin_shutdown) when the DB container restarts —
  // which the ingest recovers from. Alarming on that trains everyone to ignore this check.
  const slackAuth = logs.match(/invalid_auth|not_allowed_token_type|token_revoked|account_inactive|socket mode disabled/i);
  if (slackAuth) bad('ingest log', `Slack auth error in the recent container log ('${slackAuth[0]}') — a token may be revoked`);
  else if (/severity: 'FATAL'/.test(logs) && !/rtm socket open|socket mode open/.test(logs.split("severity: 'FATAL'").pop()))
    warn('ingest log', 'a database FATAL appears after the last successful socket open — check connectivity');
}
const LOG = `${homedir()}/.slackline/logs/ingest.log`;
if (!dockerDeploy && existsSync(LOG)) {
  const tail = readFileSync(LOG, 'utf8').split('\n').slice(-40).join('\n');
  const ageMs = Date.now() - statSync(LOG).mtimeMs;
  // The file's own mtime is the same "did ANYTHING get written recently" signal as docker's
  // per-line timestamp above — the heartbeat line is what keeps it moving on an idle connection.
  if (HEARTBEAT_MS > 0 && ageMs > STALE_MS) bad('log freshness', `log file untouched for ${fmtAge(ageMs)} (threshold ${fmtAge(STALE_MS)}) — no heartbeat means the process is wedged or dead, not merely quiet`);
  else ok('log freshness', `log touched ${fmtAge(ageMs)} ago${HEARTBEAT_MS > 0 ? ` (heartbeat every ${fmtAge(HEARTBEAT_MS)})` : ' (heartbeat disabled — recency alone is not conclusive)'}`);
  if (/socket mode open/.test(tail)) ok('slack socket', `connected at some point (log touched ${fmtAge(ageMs)} ago) — see 'log freshness' for whether it still is`);
  else warn('slack socket', 'no recent "socket mode open" in the log tail');
  const fatals = (tail.match(/fatal|invalid_auth|not_allowed_token_type/gi) || []).length;
  if (fatals) bad('daemon log', `${fatals} auth/fatal line(s) in the recent log — token may be revoked`);
} else if (!dockerDeploy) warn('daemon log', `${LOG} not found`);

// 3. Credentials still valid. A revoked token fails every other check in confusing ways.
let creds = null;
try {
  const store = createStore(); await store.init();
  creds = await resolveCreds(store);
  if (!creds) bad('credentials', 'resolveCreds returned null — bot identity could not be verified');
  else {
    const who = await api(creds, 'auth.test');
    if (who.ok) ok('credentials', `${creds.mode} mode as ${who.user_id} in ${who.team}`);
    else bad('credentials', `auth.test failed: ${who.error}`);
  }

  // 4. The buffer. Freshness matters more than existence — a store that stopped receiving an
  //    hour ago looks fine by row count alone. Supporting context only, NOT the primary signal:
  //    `origin` non-null means a live socket wrote the row; `origin=null` means a hydration path
  //    (hydrateThread/hydrateAround) backfilled it, which happens on a perfectly healthy pipeline
  //    too and proves nothing about the socket right now — this is exactly how the Aug 2026
  //    incident's rows still looked recent while the socket had been dead for 6+ hours. And a
  //    genuinely quiet channel with no traffic at all is not a fault either, so this never fails
  //    the check on its own — see 'log freshness' for the actual liveness signal.
  if (CHANNEL && creds) {
    const rows = await store.recent(creds.org, CHANNEL, 1);
    if (!rows.length) warn('buffer', `no messages stored yet for ${CHANNEL}`);
    else {
      const live = rows[0].origin != null;
      ok('buffer', `newest message ${fmtAge(Date.now() - rows[0].at)} old${live ? '' : ' (written by hydration backfill, not live ingest — not proof of a live socket)'}`);
    }
  }

  // 5. The bot must actually be IN the channel, or it receives nothing and says nothing.
  if (CHANNEL && creds) {
    const info = await api(creds, 'conversations.info', { channel: CHANNEL });
    if (!info.ok) bad('channel access', `conversations.info: ${info.error}`);
    else if (!info.channel.is_member) bad('channel access', `bot is NOT a member of #${info.channel.name} — invite it`);
    else ok('channel access', `member of #${info.channel.name}${info.channel.is_private ? ' (private)' : ''}`);
  }
} catch (e) { bad('store/credentials', e.message); }

// 6. The consumer. Buffering without a consumer is safe but inert: reports pile up unanswered.
if (SESSION) {
  const alive = sh('tmux', ['has-session', '-t', SESSION]) !== null;
  if (!alive) bad('consumer session', `tmux session '${SESSION}' is gone — reports will buffer unanswered`);
  else {
    const pane = sh('tmux', ['list-panes', '-t', SESSION, '-F', '#{pane_current_command}']) || '';
    if (!/claude/.test(pane)) warn('consumer session', `tmux '${SESSION}' is up but no claude process in it — reports will buffer unanswered`);
    else {
      const mcp = sh('sh', ['-c', 'pgrep -fc "mcp\\.mjs" || true']);
      if (Number(mcp) > 0) ok('consumer session', `claude running in '${SESSION}' with slackline MCP attached`);
      else warn('consumer session', `claude running in '${SESSION}' but no mcp.mjs child — channels push is NOT active`);
    }
  }
}

const failed = results.filter(r => r.state === 'fail');
const warned = results.filter(r => r.state === 'warn');

if (JSON_OUT) console.log(JSON.stringify({ healthy: !failed.length, results }, null, 2));
else {
  const mark = { ok: '  ok  ', warn: ' WARN ', fail: ' FAIL ' };
  for (const r of results) console.log(`[${mark[r.state]}] ${r.name.padEnd(18)} ${r.detail}`);
  console.log(failed.length ? `\n${failed.length} failing, ${warned.length} warning — pipeline is DEGRADED`
    : warned.length ? `\nhealthy, ${warned.length} warning(s)` : '\nall checks passed');
}
process.exit(failed.length ? 1 : 0);
