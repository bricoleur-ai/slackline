#!/usr/bin/env node
// Runs the health check on a timer and says something WHERE THE HUMANS ARE when the pipeline
// breaks. A health check nobody runs is not monitoring; the failure mode this guards against is
// a reporter posting into a dead channel all morning while everything looks fine from outside.
//
//   node scripts/watchdog.mjs --channel C… --tmux demo [--notify C…] [--quiet]
//
// Notifies on TRANSITIONS only (healthy→degraded, degraded→healthy), so a pipeline that stays
// broken for six hours produces one message rather than seventy-two. A repeat reminder goes out
// at most once every REMIND_MS while it stays broken, because a single alert at 03:00 that
// nobody sees is indistinguishable from no alert at all.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from '../envfile.mjs';

// Children inherit this process's env. Without the credentials loaded here, the alert-sending
// child has no tokens and the watchdog goes mute exactly when it has something to say.
loadEnvFile();

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = `${homedir()}/.slackline/watchdog-state.json`;
const REMIND_MS = 60 * 60 * 1000;                       // repeat reminder cadence while broken

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const QUIET = process.argv.includes('--quiet');
const CHANNEL = arg('channel', process.env.SLACKLINE_BRIDGE_CHANNEL);
const NOTIFY = arg('notify', CHANNEL);                  // where alerts go; defaults to the watched channel
const SESSION = arg('tmux', process.env.SLACKLINE_BRIDGE_TMUX);
const log = (m) => { if (!QUIET) console.log(`${new Date().toISOString().slice(11, 19)} ${m}`); };

// Run the health check as a child rather than importing it: it calls process.exit(), and it
// opens a store + Slack connection we do not want to inherit into a long-lived timer process.
let report;
try {
  const args = [join(HERE, 'healthcheck.mjs'), '--json'];
  if (CHANNEL) args.push('--channel', CHANNEL);
  if (SESSION) args.push('--tmux', SESSION);
  let out;
  try { out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = String(e.stdout || ''); }           // exit 1 is the degraded signal, not an error
  report = JSON.parse(out);
} catch (e) {
  // The check itself failing IS a degraded pipeline — never treat it as "probably fine".
  report = { healthy: false, results: [{ name: 'healthcheck', state: 'fail', detail: `could not run: ${e.message}` }] };
}

const failing = report.results.filter(r => r.state === 'fail');
const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8') || '{}') : {};
const now = Date.now();
const wasHealthy = prev.healthy !== false;
const lastNotified = prev.lastNotified || 0;

let notify = null;
if (!report.healthy && wasHealthy) {
  notify = `:rotating_light: slackline QA pipeline is DEGRADED\n`
    + failing.map(f => `• *${f.name}* — ${f.detail}`).join('\n')
    + `\n\nReports may be arriving with nothing acting on them. \`node scripts/healthcheck.mjs\` for detail.`;
} else if (!report.healthy && now - lastNotified > REMIND_MS) {
  const mins = Math.round((now - (prev.since || now)) / 60000);
  notify = `:rotating_light: slackline QA pipeline still degraded (${mins}m)\n`
    + failing.map(f => `• *${f.name}* — ${f.detail}`).join('\n');
} else if (report.healthy && !wasHealthy) {
  const mins = Math.round((now - (prev.since || now)) / 60000);
  notify = `:white_check_mark: slackline QA pipeline recovered after ${mins}m.`;
}

if (notify && NOTIFY) {
  try {
    execFileSync(process.execPath, [join(HERE, 'slack-reply.mjs'), '--channel', NOTIFY, '--text', notify],
      { encoding: 'utf8', timeout: 30000 });
    log(`notified ${NOTIFY}`);
  } catch (e) {
    // Posting can fail for the same reason the pipeline is down (revoked token). Say so locally
    // rather than swallowing it — otherwise the monitoring is silently unmonitored.
    log(`NOTIFY FAILED (${e.message.split('\n')[0]}) — pipeline degraded AND unable to report it`);
  }
}

writeFileSync(STATE, JSON.stringify({
  healthy: report.healthy,
  since: report.healthy === prev.healthy ? (prev.since || now) : now,
  lastNotified: notify ? now : lastNotified,
  failing: failing.map(f => f.name),
}, null, 2));

log(report.healthy ? 'healthy' : `DEGRADED: ${failing.map(f => f.name).join(', ')}`);
process.exit(report.healthy ? 0 : 1);
