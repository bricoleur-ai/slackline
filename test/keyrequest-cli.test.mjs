// Smoke test for `slackline key requests` (cli.mjs) — proves the CLI wiring reaches
// store.listKeyRequests() and applies --status filtering, via a real child process (same
// pattern as test/migrate-cli.test.mjs). Uses a throwaway sqlite file, never the live hub's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-keyreq-cli-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('slackline key requests lists rows and --status filters them, never showing key material', () => {
  withTmpDir((dir) => {
    const db = `sqlite:${path.join(dir, 'a.db')}`;
    execFileSync(process.execPath, ['-e', `
      import('${new URL('../db.mjs', import.meta.url)}').then(async ({ createStore }) => {
        const s = createStore('${db}'); await s.init();
        await s.putKeyRequest({ id: 'r1', poll_hash: 'a'.repeat(64), code: 'ABCD23', label: 'ci agent',
          orgs: 'acme', requester: 'runner', status: 'pending', created: 1000, expires_at: 601000, approver_org: 'acme' });
        await s.putKeyRequest({ id: 'r2', poll_hash: 'b'.repeat(64), code: 'EFGH34', label: 'other agent',
          orgs: '*', requester: 'runner2', status: 'denied', created: 2000, expires_at: 602000, approver_org: 'acme' });
      });
    `], { encoding: 'utf8' });

    const all = JSON.parse(run(['key', 'requests'], { SLACKLINE_STORE: db }));
    assert.equal(all.length, 2);
    assert.equal(all[0].id, 'r2');   // newest first
    for (const row of all) { assert.equal(JSON.stringify(row).includes('slk_'), false); assert.equal(row.key, undefined); }

    const pendingOnly = JSON.parse(run(['key', 'requests', '--status', 'pending'], { SLACKLINE_STORE: db }));
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].id, 'r1');
  });
});
