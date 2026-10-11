// The Muse plugin bundle is data plus two tiny scripts, and Muse COPIES it into its own cache
// on install — so the scripts cannot reach this repo by a relative path, and a mistake in the
// manifest only shows up as a session that silently never gets a push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'agents', 'muse', 'plugin');
const manifest = () => JSON.parse(readFileSync(join(BUNDLE, '.muse-plugin', 'plugin.json'), 'utf8'));

test('the manifest declares exactly the two session hooks, in the shape Muse validates', () => {
  const m = manifest();
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.name, 'slackline');
  assert.deepEqual(m.compat, { source: 'native', manifestDir: '.muse-plugin' });
  assert.deepEqual(m.capabilities.hooks.map(h => [h.id, h.event, h.command]), [
    ['session-start', 'SessionStart', ['sh', 'hooks/session-start.sh']],
    ['session-end', 'SessionEnd', ['sh', 'hooks/session-end.sh']]]);
  for (const h of m.capabilities.hooks) {
    assert.match(h.id, /^[a-z0-9][a-z0-9._-]{0,79}$/);
    assert.ok(existsSync(join(BUNDLE, h.command[1])), `${h.command[1]} must exist beneath the plugin root`);
  }
});

test('each hook script works from a copy of the bundle: it finds the repo through agents.env and passes its verb', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'slk-muse-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const copy = join(home, 'cache', 'slackline');                      // where Muse would put it
  cpSync(BUNDLE, copy, { recursive: true });
  // A stand-in repo whose agents/hook.sh records how it was called.
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'agents'), { recursive: true });
  writeFileSync(join(repo, 'agents', 'hook.sh'), `#!/bin/sh\nprintf '%s ' "$@" > "${home}/called"\ncat > "${home}/stdin"\n`);
  mkdirSync(join(home, '.slackline'));
  writeFileSync(join(home, '.slackline', 'agents.env'), `SLACKLINE_REPO='${repo}'\nSLACKLINE_NODE='${process.execPath}'\n`);
  for (const [script, verb] of [['session-start.sh', 'start'], ['session-end.sh', 'end']]) {
    const r = spawnSync('sh', [join(copy, 'hooks', script)], { input: '{"session_id":"S-1"}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.equal(readFileSync(join(home, 'called'), 'utf8'), `${verb} --agent muse `);
    assert.equal(readFileSync(join(home, 'stdin'), 'utf8'), '{"session_id":"S-1"}', 'the hook input reaches hook.sh');
  }
});

test('without the installer\'s env file a hook is a silent no-op', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'slk-muse-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = spawnSync('sh', [join(BUNDLE, 'hooks', 'session-start.sh')], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
});

test('a malformed agents.env is still a silent no-op: exit 0, no output on either stream', (t) => {
  for (const env of ["SLACKLINE_REPO='/unterminated\n", 'FOO=(\n']) {
    for (const script of ['session-start.sh', 'session-end.sh']) {
      const home = mkdtempSync(join(tmpdir(), 'slk-muse-'));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      mkdirSync(join(home, '.slackline'));
      writeFileSync(join(home, '.slackline', 'agents.env'), env);
      const r = spawnSync('sh', [join(BUNDLE, 'hooks', script)], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${script} with ${JSON.stringify(env)}`);
    }
  }
});
