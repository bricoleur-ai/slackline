// scripts/csl and agents/shell-init.sh are the two things an operator's shell actually runs.
// CLAUDE_BIN is stubbed with /bin/echo so each assertion is the exact argv claude would get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSL = join(ROOT, 'scripts', 'csl');
const INIT = join(ROOT, 'agents', 'shell-init.sh');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slk-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...process.env, HOME: dir, CLAUDE_BIN: '/bin/echo', SLACKLINE_ROUTES_FILE: join(dir, 'routes.json') } };
}

test('csl is executable and runs claude with permission prompts skipped, forwarding every argument', (t) => {
  const { dir, env } = sandbox(t);
  assert.ok(statSync(CSL).mode & 0o111, 'scripts/csl must be executable');
  assert.equal(execFileSync(CSL, ['-c'], { cwd: dir, env, encoding: 'utf8' }).trim(), '--dangerously-skip-permissions -c');
});

test('csl adds the channels flag when the caller names a server explicitly', (t) => {
  const { dir, env } = sandbox(t);
  const out = execFileSync(CSL, [], { cwd: dir, encoding: 'utf8', env: { ...env, SLACKLINE_CHANNEL_SERVERS: 'slackline' } }).trim();
  assert.equal(out, '--dangerously-load-development-channels=server:slackline --dangerously-skip-permissions');
});

test('shell-init defines the claude function and turns on the Muse switches', (t) => {
  const { dir, env } = sandbox(t);
  const out = execFileSync('bash', ['-c',
    `. "${INIT}"; type -t claude; echo "$MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING $MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS"; claude mcp list`],
    { cwd: dir, env, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['function', 'on on', 'mcp list']);
});

const bash = (dir, env, script) => execFileSync('bash', ['-c', script], { cwd: dir, env, encoding: 'utf8' }).trim().split('\n');

test('shell-init: an operator cd function that prints does not pollute the repo path', (t) => {
  const { dir, env } = sandbox(t);
  const out = bash(dir, env, `cd() { echo NOISE; builtin cd "$@"; }; . "${INIT}"; echo "$SLACKLINE_REPO_DIR"; claude hi`);
  assert.deepEqual(out, [ROOT, 'hi']);
});

test('shell-init: an earlier alias claude does not break the definition or the exports', (t) => {
  const { dir, env } = sandbox(t);
  const out = bash(dir, env, `shopt -s expand_aliases; alias claude='echo aliased'; . "${INIT}"; type -t claude; echo "$MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING"; claude hi`);
  assert.deepEqual(out, ['function', 'on', 'hi']);
});

test('shell-init: a missing or non-executable launcher falls back to command claude', (t) => {
  const { dir, env } = sandbox(t);
  // A copy of the file whose ../scripts does not exist; `claude` on PATH is a stub that echoes.
  const copy = join(dir, 'copy', 'agents');
  mkdirSync(copy, { recursive: true });
  copyFileSync(INIT, join(copy, 'shell-init.sh'));
  mkdirSync(join(dir, 'bin'));
  const stub = join(dir, 'bin', 'claude');
  writeFileSync(stub, '#!/bin/sh\necho "real claude $@"\n', { mode: 0o755 });
  const out = bash(dir, { ...env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, `. "${join(copy, 'shell-init.sh')}"; claude hi there`);
  assert.deepEqual(out, ['real claude hi there']);
});

// shell-init.sh no-ops unless BASH_VERSION is set (agents/shell-init.sh:16), so what is under
// test is "sourced from a shell that is not bash". On macOS /bin/sh IS bash, BASH_VERSION is set,
// and the script then correctly DOES define the function — so this scenario cannot be built with
// `sh` there, and asserting it fails on a perfectly correct system. Find a shell that genuinely
// is not bash; if the machine has none, skip rather than assert something untrue of it.
function nonBashShell() {
  for (const cmd of ['sh', 'dash']) {
    try {
      if (execFileSync(cmd, ['-c', 'echo ${BASH_VERSION:-}'], { encoding: 'utf8' }).trim() === '') return cmd;
    } catch { /* not installed; try the next */ }
  }
  return null;
}

test('shell-init: under a non-bash shell it defines nothing, prints nothing and returns 0', (t) => {
  const shell = nonBashShell();
  if (!shell) return t.skip('no non-bash POSIX shell here (/bin/sh is bash, as on macOS)');
  const { dir, env } = sandbox(t);
  const out = execFileSync(shell, ['-c', `. "${INIT}"; echo "status $?"; type claude 2>&1 | grep -q function && echo DEFINED; echo "[$MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING]"`],
    { cwd: dir, env: { ...env, MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING: '' }, encoding: 'utf8' });
  assert.equal(out.trim(), 'status 0\n[]');
});
