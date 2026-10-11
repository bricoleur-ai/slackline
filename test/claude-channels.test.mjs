// scripts/claude-channels.sh decides whether to add the channel-push flag to a claude launch.
// Getting this wrong is silent in both directions: add the flag where no server pushes and the
// launch may error on an unknown server; omit it where one does and the session starts healthy
// but never receives a Slack message. CLAUDE_BIN is stubbed with /bin/echo so the assertions
// are about the exact argv the wrapper would exec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-channels.sh');

function run(t, { mcpJson, args = [], env = {}, routes, argv = false, home } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'argv'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  if (mcpJson) writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcpJson));
  // Always point at a routes file inside the temp dir, so the developer's real
  // ~/.slackline/routes.json can never decide a test's outcome.
  const routesFile = join(dir, 'routes.json');
  if (routes) writeFileSync(routesFile, JSON.stringify(routes(dir)));
  // argv: true stubs claude with printf '%s\n' so each argument is one line.
  const out = execFileSync('bash', [SCRIPT, ...args], {
    cwd: dir, encoding: 'utf8',
    // HOME points at the empty temp dir so the real ~/.claude.json can't influence the result.
    env: { ...process.env, HOME: dir, CLAUDE_BIN: argv ? join(dir, 'argv') : '/bin/echo', SLACKLINE_ROUTES_FILE: routesFile, ...env },
  });
  return argv ? out.replace(/\n$/, '').split('\n') : out.trim();
}

test('adds the dev-channels flag for a server with push enabled', (t) => {
  const out = run(t, { mcpJson: { mcpServers: { slackline: { env: { SLACKLINE_CHANNEL: '1' } } } } });
  assert.equal(out, '--dangerously-load-development-channels=server:slackline');
});

test('adds nothing for an MCP server that does not push', (t) => {
  const out = run(t, { mcpJson: { mcpServers: { slackline: { env: { SLACKLINE_STORE: 'memory' } } } } });
  assert.equal(out, '', 'naming a non-pushing server would register a channel that never fires');
});

test('adds nothing when no MCP servers are configured at all', (t) => {
  assert.equal(run(t), '');
});

test('an explicit channels flag is passed through untouched', (t) => {
  const out = run(t, {
    mcpJson: { mcpServers: { slackline: { env: { SLACKLINE_CHANNEL: '1' } } } },
    args: ['--channels', 'server:other'],
  });
  assert.equal(out, '--channels server:other', 'must not second-guess an explicit caller');
});

test('an explicit attached channels flag is passed through untouched', (t) => {
  for (const a of ['--channels=server:other', '--dangerously-load-development-channels=server:other']) {
    const out = run(t, { mcpJson: PUSHING, args: [a, 'a prompt'], argv: true });
    assert.deepEqual(out, [a, 'a prompt']);
  }
});

test('node comes from SLACKLINE_NODE in ~/.slackline/agents.env when PATH has none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-node-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.slackline'));
  const log = join(dir, 'node-used');
  // A fake node that records it was run and prints a server name, as the real detection would.
  writeFileSync(join(dir, 'fakenode'), `#!/bin/sh\necho used > '${log}'\nprintf slackline\n`, { mode: 0o755 });
  writeFileSync(join(dir, '.slackline', 'agents.env'), `SLACKLINE_NODE='${join(dir, 'fakenode')}'\n`);
  writeFileSync(join(dir, 'echo.sh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  // PATH has bash's directory but no node.
  const out = execFileSync('/bin/bash', [SCRIPT, 'hello'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: '/bin:/usr/bin:/nonexistent', HOME: dir, CLAUDE_BIN: join(dir, 'echo.sh'), SLACKLINE_ROUTES_FILE: join(dir, 'r.json') },
  });
  assert.equal(readFileSync(log, 'utf8').trim(), 'used');
  assert.deepEqual(out.trim().split('\n'), ['--dangerously-load-development-channels=server:slackline', 'hello']);
});

test('SLACKLINE_CHANNELS_APPROVED=1 uses the plain --channels flag', (t) => {
  const out = run(t, {
    mcpJson: { mcpServers: { slackline: { env: { SLACKLINE_CHANNEL: '1' } } } },
    env: { SLACKLINE_CHANNELS_APPROVED: '1' },
  });
  assert.equal(out, '--channels=server:slackline');
});

test('SLACKLINE_CHANNEL_SERVERS overrides detection', (t) => {
  const out = run(t, { env: { SLACKLINE_CHANNEL_SERVERS: 'a b' } });
  assert.equal(out, '--dangerously-load-development-channels=server:a --dangerously-load-development-channels=server:b');
});

const PUSHING = { mcpServers: { slackline: { env: { SLACKLINE_CHANNEL: '1' } } } };
const ROUTED = { mcpServers: { slackline: { env: { SLACKLINE_CHANNEL: '1', SLACKLINE_ROUTES: '1' } } } };

test('a subcommand never gets the flag', (t) => {
  assert.equal(run(t, { mcpJson: PUSHING, args: ['mcp', 'list'] }), 'mcp list');
  assert.equal(run(t, { mcpJson: PUSHING, args: ['update'] }), 'update');
});

test('print mode never gets the flag', (t) => {
  assert.equal(run(t, { mcpJson: PUSHING, args: ['-p', 'summarise this'] }), '-p summarise this');
  assert.equal(run(t, { mcpJson: PUSHING, args: ['--model', 'opus', '--print', 'hi'] }), '--model opus --print hi');
});

test('a prompt as the first argument is still an interactive session', (t) => {
  // The flag is attached (--flag=server:x) so Claude Code's variadic option cannot consume the
  // prompt as a second server: the prompt stays a separate operand after the flag.
  const out = run(t, { mcpJson: PUSHING, args: ['fix the build'], argv: true });
  assert.deepEqual(out, ['--dangerously-load-development-channels=server:slackline', 'fix the build']);
});

test('a routed server gets the flag where the directory resolves to a channel', (t) => {
  const out = run(t, { mcpJson: ROUTED, routes: (dir) => ({ defaults: [], routes: [{ dir, org: 'acme', channels: ['C1'] }] }) });
  assert.equal(out, '--dangerously-load-development-channels=server:slackline');
});

test('a routed server gets nothing where the directory resolves to no channel', (t) => {
  const out = run(t, { mcpJson: ROUTED, routes: () => ({ defaults: [], routes: [{ dir: '/somewhere/else', org: 'acme', channels: ['C1'] }] }) });
  assert.equal(out, '', 'no channel to push means no startup confirmation for nothing');
});
