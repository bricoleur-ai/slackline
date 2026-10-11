import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../db.mjs';
import {
  buildManifest, writeManifest, sanitizeProjectName, ensureGitignoreEntry, writeLocalAppFile,
  persistToHomeMirror, verifyAndPersist, status, doctor, link, init, checkCliAuth, runSlackInstall,
  captureTokensViaCli, createAndJoinChannel,
} from '../app.mjs';

// Stubs global fetch for a single api() round-trip, same technique test/creds-app.test.mjs uses.
function stubFetch(reply) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { json: async () => (typeof reply === 'function' ? reply(calls.length) : reply) }; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function tmpDir() { return mkdtempSync(path.join(tmpdir(), 'slackline-app-test-')); }
function freshMemoryStore() { process.env.SLACKLINE_STORE = 'memory'; return createStore(); }

// ---- manifest ----

test('buildManifest includes every scope the app needs, and enables Socket Mode', () => {
  const m = buildManifest('example-app');
  const scopes = m.oauth_config.scopes.bot;
  for (const s of ['channels:history', 'channels:manage', 'chat:write', 'files:read', 'users:read']) assert.ok(scopes.includes(s), `missing scope ${s}`);
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.equal(m.display_information.name, 'slackline-example-app');
  assert.deepEqual(m.settings.event_subscriptions.bot_events.sort(), ['message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added', 'reaction_removed'].sort());
});

test('buildManifest is valid JSON (round-trips through JSON.stringify/parse)', () => {
  const m = buildManifest('x');
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});

test('sanitizeProjectName strips characters unsafe for a channel/app name', () => {
  assert.equal(sanitizeProjectName('My Cool Project!'), 'my-cool-project');
  assert.equal(sanitizeProjectName(''), 'project');
  assert.equal(sanitizeProjectName(null), 'project');
});

test('writeManifest writes both the slackline record and the CLI-facing project-root copy', () => {
  const cwd = tmpDir();
  try {
    writeManifest(cwd, buildManifest('proj'));
    assert.ok(existsSync(path.join(cwd, '.slackline', 'manifest.json')));
    assert.ok(existsSync(path.join(cwd, 'manifest.json')));
    const a = JSON.parse(readFileSync(path.join(cwd, '.slackline', 'manifest.json'), 'utf8'));
    const b = JSON.parse(readFileSync(path.join(cwd, 'manifest.json'), 'utf8'));
    assert.deepEqual(a, b);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---- gitignore / local secrecy ----

test('ensureGitignoreEntry appends .slackline/app.json to an existing .gitignore', () => {
  const cwd = tmpDir();
  try {
    writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
    ensureGitignoreEntry(cwd);
    const content = readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.ok(content.includes('.slackline/app.json'));
    assert.ok(content.includes('node_modules/'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('ensureGitignoreEntry creates .gitignore when none exists', () => {
  const cwd = tmpDir();
  try {
    ensureGitignoreEntry(cwd);
    assert.ok(readFileSync(path.join(cwd, '.gitignore'), 'utf8').includes('.slackline/app.json'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('ensureGitignoreEntry does not duplicate the entry on repeat calls', () => {
  const cwd = tmpDir();
  try {
    ensureGitignoreEntry(cwd); ensureGitignoreEntry(cwd);
    const lines = readFileSync(path.join(cwd, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === '.slackline/app.json');
    assert.equal(lines.length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('writeLocalAppFile writes mode 0600 and gitignores itself first', () => {
  const cwd = tmpDir();
  try {
    const creds = { org: 'acme', app_id: 'A1', bot_token: 'xoxb-SECRET', app_token: 'xapp-SECRET' };
    const file = writeLocalAppFile(cwd, creds);
    assert.equal(file, path.join(cwd, '.slackline', 'app.json'));
    assert.ok(readFileSync(path.join(cwd, '.gitignore'), 'utf8').includes('.slackline/app.json'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), creds);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('persistToHomeMirror writes under the given HOME, mode 0600, keyed by sanitized project name', () => {
  const home = tmpDir();
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = persistToHomeMirror('My Project', { org: 'acme', bot_token: 'xoxb-X' });
    assert.ok(file.endsWith(path.join('.slackline', 'apps', 'my-project.json')));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); }
});

// ---- verifyAndPersist ----

test('verifyAndPersist rejects when either token is missing, without touching the store', async () => {
  const store = { putApp: async () => { throw new Error('should not be called'); } };
  await assert.rejects(() => verifyAndPersist(store, { app_token: 'xapp-A' }), /bot token/);
  await assert.rejects(() => verifyAndPersist(store, { bot_token: 'xoxb-B' }), /app-level token/);
});

test('verifyAndPersist persists via store.putApp after a successful auth.test, and never stores a half-built credential on failure', async () => {
  const store = freshMemoryStore(); await store.init();
  const { restore } = stubFetch({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'Acme', team_id: 'T1' });
  try {
    const v = await verifyAndPersist(store, { app_token: 'xapp-A', bot_token: 'xoxb-B' });
    assert.equal(v.bot_id, 'BBOT');
    const row = await store.getApp('Acme');
    assert.equal(row.bot_id, 'BBOT');
    assert.equal(row.bot_token, 'xoxb-B');
  } finally { restore(); }
});

test('verifyAndPersist throws (and never persists) when auth.test fails — a credential without bot_id defeats the loop guard', async () => {
  const store = freshMemoryStore(); await store.init();
  const { restore } = stubFetch({ ok: false, error: 'invalid_auth' });
  try {
    await assert.rejects(() => verifyAndPersist(store, { app_token: 'xapp-A', bot_token: 'xoxb-BAD' }), /could not verify bot identity/);
    assert.equal(await store.getApp('default'), null);
  } finally { restore(); }
});

test('verifyAndPersist writes the local project file when cwd is given', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  try {
    await verifyAndPersist(store, { app_token: 'xapp-A', bot_token: 'xoxb-B' }, { cwd });
    assert.ok(existsSync(path.join(cwd, '.slackline', 'app.json')));
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test('verifyAndPersist mirrors to the home directory only when persist is requested', async () => {
  const store = freshMemoryStore(); await store.init();
  const home = tmpDir(); const realHome = process.env.HOME; process.env.HOME = home;
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  try {
    await verifyAndPersist(store, { app_token: 'xapp-A', bot_token: 'xoxb-B' }, { project: 'proj', persist: false });
    assert.equal(existsSync(path.join(home, '.slackline', 'apps', 'proj.json')), false);
    await verifyAndPersist(store, { app_token: 'xapp-A2', bot_token: 'xoxb-B2' }, { project: 'proj', persist: true });
    assert.ok(existsSync(path.join(home, '.slackline', 'apps', 'proj.json')));
  } finally { restore(); process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); }
});

// ---- status ----

test('status reports provisioned:false with no store rows', async () => {
  const store = freshMemoryStore(); await store.init();
  assert.deepEqual(await status(store, 'nope'), { provisioned: false, org: 'nope' });
});

test('status never includes token values, only presence booleans', async () => {
  const store = freshMemoryStore(); await store.init();
  await store.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: 'xoxb-SECRET', app_token: 'xapp-SECRET', bot_user_id: 'U1', bot_id: 'B1' });
  const s = await status(store, 'acme');
  assert.equal(s.provisioned, true);
  assert.equal(s.has_app_token, true);
  assert.equal(s.has_bot_token, true);
  const dump = JSON.stringify(s);
  assert.equal(dump.includes('xoxb-'), false);
  assert.equal(dump.includes('xapp-'), false);
});

test('status falls back to the sole listApps() row when getApp misses (mirrors resolveCreds)', async () => {
  const store = { getApp: async () => null, listApps: async () => [{ org: 'acme', app_id: 'A1', bot_token: 'B', app_token: 'A' }] };
  const s = await status(store);
  assert.equal(s.provisioned, true);
  assert.equal(s.org, 'acme');
});

// ---- doctor ----

test('doctor reports no_credentials when nothing is provisioned', async () => {
  const store = freshMemoryStore(); await store.init();
  const d = await doctor(store, 'nope');
  assert.equal(d.ok, false);
  assert.ok(d.issues.some((i) => i.code === 'no_credentials'));
});

test('doctor classifies an invalid_auth response as a revoked token, and never calls apps.connections.open after auth.test fails', async () => {
  const store = freshMemoryStore(); await store.init();
  await store.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: 'xoxb-BAD', app_token: 'xapp-BAD', bot_user_id: null, bot_id: null });
  const { calls, restore } = stubFetch({ ok: false, error: 'invalid_auth' });
  try {
    const d = await doctor(store, 'acme');
    assert.equal(d.ok, false);
    assert.ok(d.issues.some((i) => i.code === 'revoked_token'));
    assert.equal(calls.length, 1);   // only auth.test — connections.open must not run after a failed identity check
  } finally { restore(); }
});

test('doctor reports socket_mode_disabled when apps.connections.open fails after a good auth.test', async () => {
  const store = freshMemoryStore(); await store.init();
  await store.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: 'xoxb-OK', app_token: 'xapp-OK', bot_user_id: 'U1', bot_id: 'B1' });
  let n = 0;
  const { restore } = stubFetch(() => (++n === 1 ? { ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme' } : { ok: false, error: 'invalid_auth' }));
  try {
    const d = await doctor(store, 'acme');
    assert.equal(d.checks.auth_test, 'ok');
    assert.equal(d.ok, false);
    assert.ok(d.issues.some((i) => i.code === 'socket_mode_disabled'));
  } finally { restore(); }
});

test('doctor is fully healthy (ok:true, no issues) when everything checks out', async () => {
  const store = freshMemoryStore(); await store.init();
  await store.putApp({ org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme', bot_token: 'xoxb-OK', app_token: 'xapp-OK', bot_user_id: 'U1', bot_id: 'B1' });
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme' });
  try {
    const d = await doctor(store, 'acme');
    assert.equal(d.ok, true);
    assert.deepEqual(d.issues, []);
  } finally { restore(); }
});

// ---- link ----

test('link verifies then persists, returning a report with no token fields', async () => {
  const store = freshMemoryStore(); await store.init();
  const { restore } = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme', team_id: 'T1' });
  try {
    const r = await link(store, { appToken: 'xapp-A', botToken: 'xoxb-B' });
    assert.equal(r.ok, true);
    assert.equal(r.bot_id, 'B1');
    assert.equal('app_token' in r, false);
    assert.equal('bot_token' in r, false);
    assert.equal((await store.getApp('Acme')).bot_id, 'B1');
  } finally { restore(); }
});

test('link surfaces the verification error rather than silently no-op-ing', async () => {
  const store = freshMemoryStore(); await store.init();
  await assert.rejects(() => link(store, { appToken: 'xapp-A' }));   // no bot token
});

// ---- CLI shell-out engine (dependency-injected `run`, never spawns a real process) ----

test('checkCliAuth exits with the human login command when the CLI is unauthenticated', async () => {
  const r = await checkCliAuth({ run: async () => ({ code: 1, stdout: '', stderr: 'not authenticated' }) });
  assert.equal(r.ok, false);
  assert.equal(r.humanCommand, 'slack auth login');
});

test('checkCliAuth reports ok with an empty team list as "no authenticated teams"', async () => {
  const r = await checkCliAuth({ run: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  assert.equal(r.ok, false);
  assert.equal(r.humanCommand, 'slack auth login');
});

test('checkCliAuth returns ok:true with the parsed team list on success', async () => {
  const r = await checkCliAuth({ run: async () => ({ code: 0, stdout: JSON.stringify([{ team_id: 'T01234567', team_domain: 'example-workspace' }]), stderr: '' }) });
  assert.equal(r.ok, true);
  assert.equal(r.teams[0].team_id, 'T01234567');
});

test('checkCliAuth treats exit 0 with unparseable output as authenticated (does not hang or crash)', async () => {
  const r = await checkCliAuth({ run: async () => ({ code: 0, stdout: 'not json', stderr: '' }) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.teams, []);
});

test('runSlackInstall surfaces a clean error on nonzero exit', async () => {
  const r = await runSlackInstall('T1', { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
});

test('runSlackInstall extracts an App ID from stdout when present', async () => {
  const r = await runSlackInstall('T1', { run: async () => ({ code: 0, stdout: 'Installed app A01234567 to team T1\n', stderr: '' }) });
  assert.equal(r.ok, true);
  assert.equal(r.appId, 'A01234567');
});

test('captureTokensViaCli returns null (never throws) when the project has no package.json', async () => {
  const cwd = tmpDir();
  try {
    const t = await captureTokensViaCli(cwd, { run: async () => { throw new Error('must not be called'); } });
    assert.equal(t, null);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('captureTokensViaCli returns null and restores package.json when `slack run` never produces the capture file', async () => {
  const cwd = tmpDir();
  const pkgPath = path.join(cwd, 'package.json');
  const original = JSON.stringify({ name: 'x', scripts: { start: 'original-start' } }, null, 2) + '\n';
  writeFileSync(pkgPath, original);
  try {
    const t = await captureTokensViaCli(cwd, { run: async () => ({ code: 0, stdout: '', stderr: '' }) });
    assert.equal(t, null);
    assert.equal(readFileSync(pkgPath, 'utf8'), original);   // restored, not left swapped
    assert.equal(existsSync(path.join(cwd, '.slackline', 'capture-shim.mjs')), false);   // cleaned up
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('captureTokensViaCli reads tokens the shim wrote and cleans up afterward, restoring package.json', async () => {
  const cwd = tmpDir();
  const pkgPath = path.join(cwd, 'package.json');
  const original = JSON.stringify({ name: 'x', scripts: { start: 'original-start' } }, null, 2) + '\n';
  writeFileSync(pkgPath, original);
  try {
    // Simulate `slack run` actually invoking our swapped start script: write the capture file
    // ourselves, standing in for what the real shim would do when run as a child process.
    const fakeRun = async (bin, args, opts) => {
      const outPath = path.join(cwd, '.slackline', 'capture-tokens.json');
      writeFileSync(outPath, JSON.stringify({ app_token: 'xapp-CAPTURED', bot_token: 'xoxb-CAPTURED' }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const t = await captureTokensViaCli(cwd, { run: fakeRun });
    assert.deepEqual(t, { app_token: 'xapp-CAPTURED', bot_token: 'xoxb-CAPTURED' });
    assert.equal(readFileSync(pkgPath, 'utf8'), original);
    assert.equal(existsSync(path.join(cwd, '.slackline', 'capture-tokens.json')), false);
    assert.equal(existsSync(path.join(cwd, '.slackline', 'capture-shim.mjs')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---- createAndJoinChannel ----

test('createAndJoinChannel creates then joins', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push(url);
    if (String(url).includes('conversations.create')) return { json: async () => ({ ok: true, channel: { id: 'C1', name: body.get('name') } }) };
    if (String(url).includes('conversations.join')) return { json: async () => ({ ok: true }) };
    return { json: async () => ({ ok: false, error: 'unexpected_call' }) };
  };
  try {
    const r = await createAndJoinChannel({ mode: 'app', bot_token: 'xoxb-X' }, 'example-app');
    assert.equal(r.ok, true);
    assert.equal(r.channel.id, 'C1');
  } finally { globalThis.fetch = real; }
});

test('createAndJoinChannel falls back to an existing channel on name_taken', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('conversations.create')) return { json: async () => ({ ok: false, error: 'name_taken' }) };
    if (String(url).includes('conversations.list')) return { json: async () => ({ ok: true, channels: [{ id: 'C-EXISTING', name: 'slackline-proj' }] }) };
    if (String(url).includes('conversations.join')) return { json: async () => ({ ok: true }) };
    return { json: async () => ({ ok: false, error: 'unexpected_call' }) };
  };
  try {
    const r = await createAndJoinChannel({ mode: 'app', bot_token: 'xoxb-X' }, 'proj');
    assert.equal(r.ok, true);
    assert.equal(r.channel.id, 'C-EXISTING');
  } finally { globalThis.fetch = real; }
});

// ---- init: degrade paths (the only ones testable without a live workspace) ----

test('init exits non-zero with the human login command when the CLI is unauthenticated — never hangs on a prompt', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  try {
    const r = await init(store, { cwd, team: 'T1' }, { run: async () => ({ code: 1, stdout: '', stderr: '' }) });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'auth');
    assert.equal(r.humanCommand, 'slack auth login');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('init requires a team when none is given and more than one is authenticated', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  try {
    const run = async (bin, args) => (args[0] === 'auth')
      ? { code: 0, stdout: JSON.stringify([{ team_id: 'T1' }, { team_id: 'T2' }]), stderr: '' }
      : { code: 1, stdout: '', stderr: 'should not run install' };
    const r = await init(store, { cwd }, { run });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'team');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('init degrades with instructions when `slack app install` fails', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  try {
    const run = async (bin, args) => (args[0] === 'auth')
      ? { code: 0, stdout: JSON.stringify([{ team_id: 'T1' }]), stderr: '' }
      : { code: 1, stdout: '', stderr: 'install failed: no scopes' };
    const r = await init(store, { cwd, team: 'T1' }, { run });
    assert.equal(r.ok, false);
    assert.equal(r.step, 'install');
    assert.match(r.instructions, /slackline app link/);
    assert.ok(existsSync(path.join(cwd, 'manifest.json')));   // manifest is still written even though install failed
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('init degrades to the manual link instructions when token capture fails, and persists nothing', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  try {
    const run = async (bin, args) => {
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify([{ team_id: 'T1' }]), stderr: '' };
      if (args[0] === 'app') return { code: 0, stdout: 'Installed app A01234567\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };   // `slack run` — no capture file produced
    };
    const r = await init(store, { cwd, team: 'T1' }, { run });
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.step, 'capture');
    assert.equal(r.app_id, 'A01234567');
    assert.match(r.instructions, /slackline app link/);
    assert.equal(await store.getApp('default'), null);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('init succeeds end-to-end against fully-stubbed CLI + Web API, and persists via the store', async () => {
  const store = freshMemoryStore(); await store.init();
  const cwd = tmpDir();
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
  const { restore } = stubFetch((n) => n === 1
    ? { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team: 'Acme', team_id: 'T1' }        // auth.test
    : { ok: true, channel: { id: 'C1', name: 'slackline-x' } });                        // conversations.create/join
  try {
    const run = async (bin, args) => {
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify([{ team_id: 'T1' }]), stderr: '' };
      if (args[0] === 'app') return { code: 0, stdout: 'Installed app A01234567\n', stderr: '' };
      // `slack run` — simulate the swapped start script writing the capture file
      const outPath = path.join(cwd, '.slackline', 'capture-tokens.json');
      writeFileSync(outPath, JSON.stringify({ app_token: 'xapp-CAPTURED', bot_token: 'xoxb-CAPTURED' }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await init(store, { cwd, team: 'T1' }, { run });
    assert.equal(r.ok, true);
    assert.equal(r.bot_id, 'BBOT');
    assert.equal((await store.getApp('Acme')).bot_token, 'xoxb-CAPTURED');
    assert.equal('bot_token' in r, false);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});
