// scripts/healthcheck.mjs must detect a STALE ingest log, not just a log that once contained
// "socket mode open" — that pattern-anywhere-in-the-tail check is what let a Socket Mode
// connection wedged for ~2 days (Aug 2026) report "healthy" the entire time it delivered
// nothing. This drives the real script as a child process (same pattern as
// test/migrate-cli.test.mjs), with a fake `docker` on PATH standing in for `docker compose
// ps`/`logs --timestamps` — real docker and the live hub are never touched.
//
// The credentials/channel/consumer checks always report 'fail'/skip here (SLACKLINE_STORE=memory
// with no seeded app row, no --channel/--tmux passed) — that's fine, those checks are orthogonal
// to log freshness and this file only asserts on the 'log freshness' entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEALTHCHECK = fileURLToPath(new URL('../scripts/healthcheck.mjs', import.meta.url));

// Minimal fake `docker` CLI: answers `compose ... ps --format ...` and
// `compose ... logs ingest --tail 60 --timestamps` from canned files, nothing else.
function writeFakeDocker(binDir, { psOut, logsOut }) {
  const psFile = path.join(binDir, 'ps.out');
  const logsFile = path.join(binDir, 'logs.out');
  writeFileSync(psFile, psOut);
  writeFileSync(logsFile, logsOut);
  const script = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "ps" ]; then cat "${psFile}"; exit 0; fi
  if [ "$a" = "logs" ]; then cat "${logsFile}"; exit 0; fi
done
echo "fake docker: unhandled args: $*" >&2
exit 1
`;
  const dockerBin = path.join(binDir, 'docker');
  writeFileSync(dockerBin, script);
  chmodSync(dockerBin, 0o755);
}

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-healthcheck-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Runs the real healthcheck.mjs against a fake docker deployment and returns its parsed --json
// result. Exit code is always 1 in this hermetic setup (no real Slack creds), so tolerate that.
function runHealthcheck(deployDir, extraEnv) {
  const env = {
    ...process.env,
    PATH: `${deployDir}/bin:${process.env.PATH}`,
    SLACKLINE_DEPLOY_DIR: deployDir,
    SLACKLINE_STORE: 'memory',        // hermetic: never the live hub's Postgres
    DATABASE_URL: 'postgres://unused/unused',   // set so healthcheck's own docker-deploy
    // DATABASE_URL auto-construction (which would point at a real port) is skipped; SLACKLINE_STORE wins anyway.
    ...extraEnv,
  };
  try {
    return JSON.parse(execFileSync(process.execPath, [HEALTHCHECK, '--json'], { encoding: 'utf8', env }));
  } catch (e) {
    // execFileSync throws on the script's non-zero exit (expected here); stdout still has the JSON.
    return JSON.parse(e.stdout);
  }
}

function setup(dir, { psOut, logsOut }) {
  writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(path.join(dir, '.env'), 'PG_EXPOSE=1\n');   // never actually read: DATABASE_URL/SLACKLINE_STORE already set
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFakeDocker(bin, { psOut, logsOut });
}

test('log freshness FAILS when the newest log line is older than the staleness threshold', () => {
  withTmpDir((dir) => {
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();   // 10 minutes ago
    setup(dir, {
      psOut: 'ingest running healthy\napi running healthy\n',
      logsOut: `ingest-1  | ${staleTs} 12:00:00 [acme] socket mode open\n`,
    });
    // heartbeatMs=60s -> stale threshold defaults to 3x = 180s; 10 minutes is well past it.
    const { results } = runHealthcheck(dir, { SLACKLINE_HEARTBEAT_MS: '60000' });
    const freshness = results.find(r => r.name === 'log freshness');
    assert.ok(freshness, 'expected a log freshness result');
    assert.equal(freshness.state, 'fail');
    assert.match(freshness.detail, /no log output in/);
  });
});

test('log freshness PASSES when the newest log line is within the staleness threshold', () => {
  withTmpDir((dir) => {
    const freshTs = new Date(Date.now() - 5000).toISOString();   // 5 seconds ago
    setup(dir, {
      psOut: 'ingest running healthy\napi running healthy\n',
      logsOut: `ingest-1  | ${freshTs} 12:00:05 [acme] heartbeat connected=true idleSec=5\n`,
    });
    const { results } = runHealthcheck(dir, { SLACKLINE_HEARTBEAT_MS: '60000' });
    const freshness = results.find(r => r.name === 'log freshness');
    assert.ok(freshness);
    assert.equal(freshness.state, 'ok');
    assert.match(freshness.detail, /log active/);
  });
});

test('a stale log fails even though "socket mode open" appears in the tail — recency, not history', () => {
  // This is the exact incident shape: the only log line is an old "socket mode open" with
  // nothing since. The old pattern-anywhere check would have called this healthy.
  withTmpDir((dir) => {
    const staleTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();   // 1 hour ago
    setup(dir, {
      psOut: 'ingest running healthy\napi running healthy\n',
      logsOut: `ingest-1  | ${staleTs} 09:00:00 [Acme Corp] socket mode open\n`,
    });
    const { results } = runHealthcheck(dir, { SLACKLINE_HEARTBEAT_MS: '300000' });   // 5min default -> 15min threshold
    const freshness = results.find(r => r.name === 'log freshness');
    assert.equal(freshness.state, 'fail');
    // The older, weaker check must still report what it always did (history, not currently wrong)...
    const socket = results.find(r => r.name === 'slack socket');
    assert.equal(socket.state, 'ok');
    // ...but it is 'log freshness', not 'slack socket', that actually catches the wedge.
  });
});

test('SLACKLINE_HEARTBEAT_MS=0 falls back to the old history-only check instead of failing on recency', () => {
  withTmpDir((dir) => {
    const staleTs = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();   // 6 hours ago
    setup(dir, {
      psOut: 'ingest running healthy\napi running healthy\n',
      logsOut: `ingest-1  | ${staleTs} 03:00:00 [acme] socket mode open\n`,
    });
    const { results } = runHealthcheck(dir, { SLACKLINE_HEARTBEAT_MS: '0' });
    const freshness = results.find(r => r.name === 'log freshness');
    // Heartbeat disabled -> recency can't be trusted, so this degrades to a warning, not a hard
    // failure purely from staleness (matches the documented "heartbeat disabled" fallback).
    assert.equal(freshness.state, 'warn');
  });
});
