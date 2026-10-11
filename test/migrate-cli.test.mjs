// Smoke test for the `slackline migrate` CLI wiring in cli.mjs itself (flag parsing + dispatch
// to migrate.mjs). The functional coverage lives in migrate-store.test.mjs/migrate-file.test.mjs
// against migrate.mjs directly; this file only proves `node cli.mjs migrate ...` actually reaches
// that code with the right arguments, via a real child process (same pattern as
// test/bridge-tmux.test.mjs's execFileSync use). Uses sqlite files under a throwaway tmp dir —
// never SLACKLINE_STORE=the live ~/.slackline/demo.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-migrate-cli-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('slackline migrate export/import/copy/verify round-trip via the CLI, end to end', () => {
  withTmpDir((dir) => {
    const a = `sqlite:${path.join(dir, 'a.db')}`;
    const b = `sqlite:${path.join(dir, 'b.db')}`;
    const dump = path.join(dir, 'dump.ndjson');

    // seed store a with a message + a token via the running store, not shelled-out SQL —
    // exercise the same createStore() path the CLI itself uses.
    execFileSync(process.execPath, ['-e', `
      import('${new URL('../db.mjs', import.meta.url)}').then(async ({ createStore }) => {
        const s = createStore('${a}'); await s.init();
        await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi', at: 1 });
        await s.putToken({ org: 'acme', team_name: 'T', token: 'xoxc-CLI-TEST', cookie: 'd=cli-test', user_id: 'U1' });
      });
    `], { encoding: 'utf8' });

    const exportOut = run(['migrate', 'export', '--out', dump], { SLACKLINE_STORE: a });
    const exportResult = JSON.parse(exportOut);
    assert.equal(exportResult.tables.messages, 1);
    assert.equal(exportResult.tables.tokens, 1);
    assert.equal(statSync(dump).mode & 0o777, 0o600);

    const importOut = run(['migrate', 'import', '--in', dump], { SLACKLINE_STORE: b });
    const importResult = JSON.parse(importOut);
    assert.equal(importResult.tables.messages, 1);

    // re-import is idempotent
    const importOut2 = run(['migrate', 'import', '--in', dump], { SLACKLINE_STORE: b });
    assert.deepEqual(JSON.parse(importOut2).tables, importResult.tables);

    const copyOut = run(['migrate', 'copy', '--from', a, '--to', b]);
    assert.equal(JSON.parse(copyOut).tables.messages, 1);

    const verifyOut = run(['migrate', 'verify', '--from', a, '--to', b]);
    const verifyResult = JSON.parse(verifyOut);
    assert.equal(verifyResult.ok, true, verifyOut);
    assert.equal(verifyResult.tables.tokens.credentials.acme.token, 'match');
  });
});

test('slackline migrate verify exits non-zero and reports drift when stores disagree', () => {
  withTmpDir((dir) => {
    const a = `sqlite:${path.join(dir, 'a.db')}`;
    const b = `sqlite:${path.join(dir, 'b.db')}`;
    execFileSync(process.execPath, ['-e', `
      import('${new URL('../db.mjs', import.meta.url)}').then(async ({ createStore }) => {
        const s = createStore('${a}'); await s.init();
        await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi', at: 1 });
        await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.2', user: 'U1', text: 'bye', at: 2 });
      });
    `], { encoding: 'utf8' });
    execFileSync(process.execPath, [CLI, 'migrate', 'copy', '--from', a, '--to', b], { encoding: 'utf8' });
    execFileSync(process.execPath, ['-e', `
      import('${new URL('../db.mjs', import.meta.url)}').then(async ({ createStore }) => {
        const s = createStore('${a}'); await s.init();
        await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.3', user: 'U1', text: 'unsynced', at: 3 });
      });
    `], { encoding: 'utf8' });

    let threw = false, stdout = '';
    try { run(['migrate', 'verify', '--from', a, '--to', b]); }
    catch (e) { threw = true; stdout = e.stdout; }
    assert.equal(threw, true, 'verify must exit non-zero on drift');
    const r = JSON.parse(stdout);
    assert.equal(r.ok, false);
    assert.equal(r.tables.messages.drift, 1);
  });
});

test('slackline migrate --tables restricts export to the requested tables', () => {
  withTmpDir((dir) => {
    const a = `sqlite:${path.join(dir, 'a.db')}`;
    const dump = path.join(dir, 'dump.ndjson');
    execFileSync(process.execPath, ['-e', `
      import('${new URL('../db.mjs', import.meta.url)}').then(async ({ createStore }) => {
        const s = createStore('${a}'); await s.init();
        await s.putMessage({ org: 'acme', channel: 'C1', ts: '1.1', user: 'U1', text: 'hi', at: 1 });
        await s.putUser('acme', { id: 'U1', name: 'alice' });
      });
    `], { encoding: 'utf8' });
    const out = run(['migrate', 'export', '--out', dump, '--tables', 'users'], { SLACKLINE_STORE: a });
    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r.tables), ['users']);
  });
});

test('slackline migrate export --dry-run does not create a file', () => {
  withTmpDir((dir) => {
    const a = `sqlite:${path.join(dir, 'a.db')}`;
    const dump = path.join(dir, 'should-not-exist.ndjson');
    const out = run(['migrate', 'export', '--out', dump, '--dry-run'], { SLACKLINE_STORE: a });
    assert.equal(JSON.parse(out).dryRun, true);
    assert.throws(() => statSync(dump));
  });
});

test('slackline migrate export without --out fails with a usage message, not a crash', () => {
  withTmpDir((dir) => {
    const a = `sqlite:${path.join(dir, 'a.db')}`;
    assert.throws(() => execFileSync(process.execPath, [CLI, 'migrate', 'export'], { encoding: 'utf8', env: { ...process.env, SLACKLINE_STORE: a } }));
  });
});
