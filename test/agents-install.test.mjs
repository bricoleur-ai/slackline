// agents/install.mjs edits other programs' config files on someone's machine. The tests pin
// the three promises that makes tolerable: it is idempotent, uninstall removes exactly what
// install added, and when it cannot be sure a file is safe to edit it refuses and leaves the
// file byte-for-byte alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import * as I from '../agents/install.mjs';

const at = { node: '/usr/bin/node', repo: '/opt/slackline' };
const MCP = '/opt/slackline/mcp.mjs';
const BLOCK = (body) => `# >>> slackline >>>\n${body}\n# <<< slackline <<<\n`;

test('setBlock/dropBlock: add, replace in place, and remove exactly', () => {
  const orig = 'alias ll="ls -l"\nexport X=1\n';
  const once = I.setBlock(orig, 'line one');
  assert.equal(once, orig + '\n' + BLOCK('line one'));
  assert.equal(I.setBlock(once, 'line one'), once, 'idempotent');
  const twice = I.setBlock(once, 'line two');
  assert.ok(twice.includes('line two') && !twice.includes('line one'), 'replaced, not appended');
  assert.equal(I.dropBlock(once), orig, 'removal restores the original bytes');
  assert.equal(I.dropBlock(orig), orig);
  assert.equal(I.setBlock('', 'x'), BLOCK('x'));
  assert.equal(I.dropBlock(BLOCK('x')), '');
  assert.equal(I.dropBlock('a\n\n' + BLOCK('x') + 'later line\n'), 'a\nlater line\n', 'text the operator added after the block survives');
  assert.throws(() => I.dropBlock('a\n# >>> slackline >>>\nno end\n'), /no end marker/);
});

// Codex's registration is not kept in a marker block in config.toml. Nothing writes
// that block; dropCodexBlock only removes one, and only when it is whole.
const OLD_BLOCK = BLOCK('# Managed by `slackline agents install codex`; edits inside this block are overwritten.\n[mcp_servers.slackline]\ncommand = "/usr/bin/node"\nargs = ["/opt/slackline/mcp.mjs"]\nenv = { SLACKLINE_REMOTE_ONLY = "1" }');
// What `codex mcp add` (Codex 0.160.1) made of a config that held the block: the opening marker
// gone, the table moved and rewritten, the closing marker left alone on the last line.
const REWRITTEN = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.slackline]\ncommand = "/usr/bin/node"\nargs = ["/opt/slackline/mcp.mjs"]\n\n[mcp_servers.slackline.env]\nSLACKLINE_REMOTE_ONLY = "1"\n\n[tui]\nx = 1\n# <<< slackline <<<\n';

test('dropCodexBlock removes the block only when it holds exactly what the old installer wrote', () => {
  const orig = 'model = "gpt"\n';
  const odd = (...extra) => BLOCK('# Managed by `slackline agents install codex`; edits inside this block are overwritten.\n[mcp_servers.slackline]\ncommand = "/n"\nargs = ["/x/mcp.mjs"]\nenv = { SLACKLINE_REMOTE_ONLY = "1" }\n\n' + extra.join('\n'));
  assert.equal(I.dropCodexBlock(orig + '\n' + odd()), orig, 'any values, blank lines allowed');
  for (const [what, extra] of Object.entries({
    'a hooks.state table': ['[hooks.state."/h/hooks.json:session_start:0:0"]', 'trusted_hash = "sha256:aa"'],
    'a projects table': ['[projects."/p"]', 'trust_level = "trusted"'],
    'a different key': ['startup_timeout_sec = 30'],
    'another comment': ['# mine'],
  })) {
    const text = orig + '\n' + odd(...extra);
    assert.throws(() => I.dropCodexBlock(text), /marker block with something else inside it \(line \d+: .*\) — remove the block by hand/, what);
  }
});

test('dropCodexBlock removes a whole old block exactly, and refuses a damaged one by line number', () => {
  const orig = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
  assert.equal(I.dropCodexBlock(orig + '\n' + OLD_BLOCK), orig, 'removal restores the original bytes');
  assert.equal(I.dropCodexBlock(orig), orig, 'no block: untouched');
  assert.equal(I.dropCodexBlock(''), '');
  assert.throws(() => I.dropCodexBlock(REWRITTEN), /line 15: # <<< slackline <<<.*delete that line by hand/, 'a closing marker with no opening one');
  assert.throws(() => I.dropCodexBlock('a = 1\n# >>> slackline >>>\n[mcp_servers.slackline]\ncommand = "n"\n'), /line 2: # >>> slackline >>>.*delete that line by hand/, 'an opening marker with no closing one');
  assert.throws(() => I.dropCodexBlock('# <<< slackline <<<\n' + OLD_BLOCK), /line 1: # <<< slackline <<<; line 2: # >>> slackline >>>; line 8: # <<< slackline <<<.*delete those lines by hand/, 'anything but one whole block');
});

test('codexHooks adds SessionStart and SessionEnd next to other hooks, and removes only its own', () => {
  const theirs = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/their/hook' }] }], Stop: [{ hooks: [{ type: 'command', command: '/their/stop' }] }] } };
  const out = I.codexHooks(JSON.stringify(theirs), at);
  const j = JSON.parse(out);
  assert.equal(j.hooks.SessionStart.length, 2);
  assert.deepEqual(j.hooks.SessionStart[0], theirs.hooks.SessionStart[0], 'their hook is kept, first');
  assert.deepEqual(j.hooks.SessionStart[1], { hooks: [{ type: 'command', command: "'/opt/slackline/agents/hook.sh' start --agent codex" }] });
  assert.deepEqual(j.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: "'/opt/slackline/agents/hook.sh' end --agent codex" }] }]);
  assert.deepEqual(j.hooks.Stop, theirs.hooks.Stop);
  assert.equal(I.codexHooks(out, at), out, 'idempotent');
  assert.deepEqual(JSON.parse(I.unCodexHooks(out, at)), theirs);
  assert.deepEqual(JSON.parse(I.unCodexHooks(I.codexHooks('', at), at)), {}, 'a file we created ends up empty, not broken');
  assert.equal(I.unCodexHooks(JSON.stringify(theirs), at), JSON.stringify(theirs), 'nothing of ours: untouched');
});

test('opencodeJson and museSettings add one entry and leave every other key alone', () => {
  const oc = JSON.stringify({ model: 'local/qwen', mcp: { other: { type: 'local', command: ['x'] } } }, null, 2) + '\n';
  const ocOut = JSON.parse(I.opencodeJson(oc, at));
  assert.equal(ocOut.model, 'local/qwen');
  assert.deepEqual(ocOut.mcp.other, { type: 'local', command: ['x'] });
  assert.deepEqual(ocOut.mcp.slackline, { type: 'local', command: ['/usr/bin/node', MCP], environment: { SLACKLINE_REMOTE_ONLY: '1' }, enabled: true });
  assert.deepEqual(JSON.parse(I.unOpencodeJson(I.opencodeJson(oc, at), at)), JSON.parse(oc));
  assert.deepEqual(JSON.parse(I.unOpencodeJson(I.opencodeJson('{"model":"m"}', at), at)), { model: 'm' }, 'an mcp section we created is removed with our entry');

  const mu = '{"provider":"meta","mcpServers":{"peer_bus":{"command":"py"}}}';
  const muOut = JSON.parse(I.museSettings(mu, at));
  assert.deepEqual(muOut.mcpServers.peer_bus, { command: 'py' });
  assert.deepEqual(muOut.mcpServers.slackline, { mode: 'optional', command: '/usr/bin/node', args: [MCP], env: { SLACKLINE_REMOTE_ONLY: '1' } });
  assert.deepEqual(JSON.parse(I.unMuseSettings(I.museSettings(mu, at), at)), JSON.parse(mu));
});

test('a JSON config is returned untouched when our entry is already there, so a re-run rewrites nothing', () => {
  const once = I.opencodeJson('{"model":"m"}', at);
  assert.equal(I.opencodeJson(once, at), once);
  assert.equal(I.museSettings(I.museSettings('', at), at), I.museSettings('', at));
});

test('JSON configs: refuse a file that is not plain JSON, and refuse to replace someone else\'s entry', () => {
  assert.throws(() => I.opencodeJson('{\n  // my comment\n  "model": "m"\n}\n', at), /not plain JSON/);
  assert.throws(() => I.museSettings('[1,2]', at), /not plain JSON/);
  assert.throws(() => I.opencodeJson('{"mcp":{"slackline":{"type":"local","command":["node","/elsewhere/mcp.mjs"]}}}', at), /different "mcp\.slackline"/);
  assert.throws(() => I.museSettings('{"mcpServers":{"slackline":{"command":"other"}}}', at), /different "mcpServers\.slackline"/);
  assert.equal(I.unOpencodeJson('{"mcp":{"slackline":{"command":["node","/elsewhere/mcp.mjs"]}}}', at), '{"mcp":{"slackline":{"command":["node","/elsewhere/mcp.mjs"]}}}', 'uninstall never removes someone else\'s entry');
});

test('agentsEnv records the repo and node, and keeps the operator\'s delivery choices on a re-run', () => {
  const first = I.agentsEnv('', at);
  assert.match(first, /^SLACKLINE_REPO='\/opt\/slackline'$/m);
  assert.match(first, /^SLACKLINE_NODE='\/usr\/bin\/node'$/m);
  assert.match(first, /^SLACKLINE_DELIVER_CODEX=native$/m);
  assert.match(first, /^SLACKLINE_DELIVER_MUSE=tmux$/m, 'Muse refuses shell-sent session messages, so it starts on tmux');
  const edited = first.replace('SLACKLINE_DELIVER_MUSE=tmux', 'SLACKLINE_DELIVER_MUSE=native');
  assert.match(I.agentsEnv(edited, { node: '/new/node', repo: '/new/repo' }), /^SLACKLINE_DELIVER_MUSE=native$/m, 'an existing native is kept');
  assert.match(I.agentsEnv(edited, { node: '/new/node', repo: '/new/repo' }), /^SLACKLINE_NODE='\/new\/node'$/m);
  assert.match(I.agentsEnv('', { node: '/n', repo: "/it's here" }), /^SLACKLINE_REPO='\/it'\\''s here'$/m, 'paths are shell-quoted');
});

test('bashrc sources shell-init from a managed block; the OpenCode plugin file re-exports exactly one name', () => {
  assert.equal(I.unBashrc(I.bashrc('export A=1\n', at), at), 'export A=1\n');
  assert.match(I.bashrc('', at), /\[ -r '\/opt\/slackline\/agents\/shell-init\.sh' \] && \. '\/opt\/slackline\/agents\/shell-init\.sh'/);
  assert.match(I.opencodePlugin(at), /^export \{ SlacklinePlugin \} from "\/opt\/slackline\/agents\/opencode\/plugin\.mjs";$/m);
  assert.equal(I.opencodePlugin(at).match(/^export /gm).length, 1);
});

// One stdio server as `codex mcp list --json` prints it (Codex 0.160.1).
const server = (name, command, args, env = null) => ({ name, enabled: true, disabled_reason: null,
  transport: { type: 'stdio', command, args, env, env_vars: [], cwd: null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported' });
const OURS = server('slackline', '/usr/bin/node', [MCP], { SLACKLINE_REMOTE_ONLY: '1' });

// A stand-in for `codex mcp list|add|remove` that keeps the registrations in memory.
function fakeCodex(servers) {
  const state = { servers: [...servers] };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  state.run = (cmd, args) => {
    if (cmd !== 'codex' || args[0] !== 'mcp') return null;
    if (args[1] === 'list') return ok(JSON.stringify(state.servers));
    if (args[1] === 'remove') { state.servers = state.servers.filter(s => s.name !== args[2]); return ok(); }
    if (args[1] === 'add') {
      const dash = args.indexOf('--'), env = {};
      for (let i = 3; i < dash; i += 2) { assert.equal(args[i], '--env'); const eq = args[i + 1].indexOf('='); env[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1); }
      assert.ok(!state.servers.some(s => s.name === args[2]), 'never adds over an existing registration');
      state.servers.push(server(args[2], args[dash + 1], args.slice(dash + 2), env));
    }
    return ok();
  };
  return state;
}

// A fake HOME with the given files, plus a context whose external commands are recorded. A
// test's own runImpl answers first; what it leaves unanswered goes to the fake codex, and
// everything else succeeds silently.
function sandbox(t, files = {}, runImpl, { servers = [], node = at.node, repo = at.repo } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'slk-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), text); }
  const calls = [], codex = fakeCodex(servers);
  const context = (stamp) => I.context({ home, node, repo, stamp, env: {},
    runImpl: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return (runImpl && await runImpl(cmd, args)) || codex.run(cmd, args) || { code: 0, stdout: cmd === 'muse' && args[1] === 'list' ? '[]' : '', stderr: '' }; } });
  // Silence the installer's progress lines once per test (a test may build two sandboxes).
  if (!console.log.mock) { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); }
  return { home, c: context('STAMP'), context, calls, codex, read: (rel) => readFileSync(join(home, rel), 'utf8'), has: (rel) => existsSync(join(home, rel)) };
}
const EXISTING = {
  '.bashrc': 'export A=1\n',
  '.codex/config.toml': 'model = "gpt"\n',
  '.config/opencode/opencode.json': '{\n  "model": "local/qwen"\n}\n',
  '.config/muse/settings.json': '{\n  "provider": "meta"\n}\n',
  '.local/bin/csl': '#!/bin/sh\necho old csl\n',
};

test('install wires every target, backs up each file it changes, and a second run changes nothing', async (t) => {
  const { home, c, context, calls, codex, read, has } = sandbox(t, EXISTING);
  assert.equal(await I.main(['install'], c), 0);

  assert.match(read('.slackline/agents.env'), /SLACKLINE_REPO='\/opt\/slackline'/);
  assert.deepEqual(JSON.parse(read('.slackline/routes.json')), { defaults: [], routes: [] });
  assert.match(read('.bashrc'), /shell-init\.sh/);
  assert.equal(readlinkSync(join(home, '.local/bin/csl')), '/opt/slackline/scripts/csl');
  assert.deepEqual(codex.servers, [OURS], 'Codex is registered through its own CLI');
  assert.equal(read('.codex/config.toml'), EXISTING['.codex/config.toml'], 'the installer itself does not edit config.toml (the fake codex does not either)');
  assert.match(read('.codex/hooks.json'), /hook\.sh' start --agent codex/);
  assert.equal(JSON.parse(read('.config/opencode/opencode.json')).mcp.slackline.command[1], MCP);
  assert.match(read('.config/opencode/plugin/slackline.js'), /SlacklinePlugin/);
  assert.equal(JSON.parse(read('.config/muse/settings.json')).mcpServers.slackline.args[0], MCP);
  assert.deepEqual(calls, [
    'claude mcp add -s user slackline -e SLACKLINE_CHANNEL=1 -e SLACKLINE_ROUTES=1 -e SLACKLINE_REMOTE_ONLY=1 -- /usr/bin/node /opt/slackline/mcp.mjs',
    'codex mcp list --json',
    'codex mcp add slackline --env SLACKLINE_REMOTE_ONLY=1 -- /usr/bin/node /opt/slackline/mcp.mjs',
    'muse plugins list --json',
    'muse plugins install /opt/slackline/agents/muse/plugin --scope user --json',
    'muse plugins approve slackline --json',
    'muse plugins enable slackline --json']);

  for (const [rel, text] of Object.entries(EXISTING)) assert.equal(read(`${rel}.bak-slackline-STAMP`), text, `backup of ${rel}`);
  assert.equal(read('.codex/config.toml.bak-slackline-STAMP'), 'model = "gpt"\n', 'codex mcp add rewrites config.toml, so it is backed up first');
  assert.ok(!has('.codex/hooks.json.bak-slackline-STAMP'), 'a file that did not exist has nothing to back up');

  const snapshot = Object.fromEntries(['.bashrc', '.codex/config.toml', '.codex/hooks.json', '.config/opencode/opencode.json', '.config/muse/settings.json'].map(f => [f, read(f)]));
  calls.length = 0;
  assert.equal(await I.main(['install', 'shell', 'opencode', 'codex'], context('SECOND')), 0);
  for (const [f, text] of Object.entries(snapshot)) assert.equal(read(f), text, `${f} unchanged on a second run`);
  assert.equal(readdirSync(join(home, '.codex')).filter(f => f.includes('SECOND')).length, 0, 'no new backups when nothing changes');
  assert.deepEqual(calls, ['codex mcp list --json'], 'a registration that is already right is read, not rewritten');
  assert.deepEqual(codex.servers, [OURS]);
});

test('uninstall removes exactly what install added', async (t) => {
  const { home, c, codex, read, has } = sandbox(t, EXISTING, null, { servers: [server('other', 'x', [])] });
  await I.main(['install'], c);
  assert.equal(await I.main(['uninstall'], c), 0);
  assert.equal(read('.bashrc'), EXISTING['.bashrc']);
  assert.equal(read('.codex/config.toml'), EXISTING['.codex/config.toml']);
  assert.deepEqual(codex.servers.map(s => s.name), ['other'], 'our Codex registration is removed; another server is not');
  assert.deepEqual(JSON.parse(read('.codex/hooks.json')), {});
  assert.deepEqual(JSON.parse(read('.config/opencode/opencode.json')), { model: 'local/qwen' });
  assert.deepEqual(JSON.parse(read('.config/muse/settings.json')), { provider: 'meta' });
  assert.ok(!has('.config/opencode/plugin/slackline.js'));
  assert.throws(() => lstatSync(join(home, '.local/bin/csl')), /ENOENT/, 'our symlink is gone; the original is in its backup');
});

test('a config that cannot be edited safely is left byte-for-byte alone, and the other targets still install', async (t) => {
  const jsonc = '{\n  // local models\n  "model": "local/qwen"\n}\n';
  const { home, c, codex, read, has } = sandbox(t, { ...EXISTING, '.config/opencode/opencode.json': jsonc });
  assert.equal(await I.main(['install', 'opencode', 'codex'], c), 1, 'a refused target makes the exit code non-zero');
  assert.equal(read('.config/opencode/opencode.json'), jsonc);
  assert.ok(!has('.config/opencode/opencode.json.bak-slackline-STAMP'));
  assert.ok(!has('.config/opencode/plugin/slackline.js'), 'no half-installed target: the plugin is not written when the config was refused');
  assert.deepEqual(codex.servers, [OURS]);
  assert.match(read('.codex/hooks.json'), /hook\.sh' start --agent codex/);
  assert.ok(home);
});

test('Claude Code: an existing server of ours is replaced; someone else\'s is refused', async (t) => {
  const ours = { mcpServers: { slackline: { type: 'stdio', command: 'node', args: [MCP], env: {} } } };
  const a = sandbox(t, { '.claude.json': JSON.stringify(ours) });
  assert.equal(await I.main(['install', 'claude'], a.c), 0);
  assert.deepEqual(a.calls.map(s => s.split(' ').slice(0, 3).join(' ')), ['claude mcp remove', 'claude mcp add']);
  const b = sandbox(t, { '.claude.json': JSON.stringify({ mcpServers: { slackline: { command: 'node', args: ['/elsewhere/mcp.mjs'] } } }) });
  assert.equal(await I.main(['install', 'claude'], b.c), 1);
  assert.deepEqual(b.calls, []);
});

test('a failing external command is reported, not swallowed', async (t) => {
  const { c } = sandbox(t, {}, async (cmd) => (cmd === 'claude' ? { code: 1, stdout: '', stderr: 'error: not logged in\n' } : { code: 0, stdout: '', stderr: '' }));
  assert.equal(await I.main(['install', 'claude'], c), 1);
  assert.ok(console.error.mock.calls.some(call => /claude mcp add failed: error: not logged in/.test(String(call.arguments[0]))));
});

test('unknown verbs and targets are a usage error', async (t) => {
  const { c } = sandbox(t);
  assert.equal(await I.main(['install', 'emacs'], c), 1);
  assert.equal(await I.main(['frobnicate'], c), 1);
  assert.equal(await I.main([], c), 1);
});

test('inspect reports what is wired, the delivery modes, and live versus stale listeners', async (t) => {
  const { home, c } = sandbox(t, EXISTING, async (cmd, args) => (cmd === 'muse' ? { code: 0, stdout: args[1] === 'list' ? '[{"id":"slackline"}]' : '', stderr: '' } : null));
  await I.main(['install'], c);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { slackline: { command: '/usr/bin/node', args: [MCP] } } }));
  writeFileSync(join(home, '.slackline/agents.env'), readFileSync(join(home, '.slackline/agents.env'), 'utf8').replace('DELIVER_MUSE=native', 'DELIVER_MUSE=tmux'));
  mkdirSync(join(home, '.slackline/run'), { recursive: true });
  writeFileSync(join(home, '.slackline/run/codex-T-1.pid'), String(process.pid));
  writeFileSync(join(home, '.slackline/run/muse-S-2.pid'), '4999999');
  const s = await I.inspect(c);
  assert.deepEqual(s.claude, { tools: true, push: true });
  assert.deepEqual(s.opencode, { tools: true, push: true });
  assert.deepEqual(s.codex, { tools: true, push: true, deliver: 'native' });
  assert.deepEqual(s.muse, { tools: true, push: true, deliver: 'tmux' });
  assert.deepEqual(s.listeners.sort((x, y) => x.name.localeCompare(y.name)),
    [{ name: 'codex-T-1', pid: process.pid, alive: true }, { name: 'muse-S-2', pid: 4999999, alive: false }]);
  const text = await I.status(c, home);
  assert.match(text, /^hub\s+NOT CONFIGURED/m);
  assert.match(text, /^route\s+.*\(nothing routed: tools only\)/m);
  assert.match(text, /^muse\s+tools: yes\s+push: yes\s+deliver: tmux/m);
  assert.match(text, /muse-S-2 \(pid 4999999, DEAD/);
});

// ---- ownership by parsed values, and never half-installing a target ----

// One ordered log of everything the installer prints, for tests about ordering.
function capture(t) {
  const out = [];
  t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => out.push(a.join(' ')));
  return out;
}

test('a hand-written entry that runs our mcp.mjs with other env is theirs: refused on install, left on uninstall', async (t) => {
  const oc = JSON.stringify({ mcp: { slackline: { type: 'local', command: ['/usr/bin/node', MCP], environment: { SLACKLINE_ORG: 'x', SLACKLINE_CHANNEL_ONLY: '1' }, enabled: true } } }, null, 2) + '\n';
  const mu = JSON.stringify({ mcpServers: { slackline: { mode: 'optional', command: '/usr/bin/node', args: [MCP], env: { SLACKLINE_CHANNEL_ONLY: '1' } } } }, null, 2) + '\n';
  const { c, read, has } = sandbox(t, { '.config/opencode/opencode.json': oc, '.config/muse/settings.json': mu });
  assert.equal(await I.main(['install', 'opencode', 'muse'], c), 1);
  assert.equal(read('.config/opencode/opencode.json'), oc);
  assert.equal(read('.config/muse/settings.json'), mu);
  assert.ok(!has('.config/opencode/opencode.json.bak-slackline-STAMP') && !has('.config/muse/settings.json.bak-slackline-STAMP'));
  assert.ok(!has('.config/opencode/plugin/slackline.js'));
  assert.equal(await I.main(['uninstall', 'opencode', 'muse'], c), 0);
  assert.equal(read('.config/opencode/opencode.json'), oc);
  assert.equal(read('.config/muse/settings.json'), mu);
});

test('Claude Code: a hand-written entry is refused with no commands; one equal to ours runs none either; uninstall removes only ours', async (t) => {
  const entry = (env) => JSON.stringify({ mcpServers: { slackline: { type: 'stdio', command: '/usr/bin/node', args: [MCP], env } } });
  const a = sandbox(t, { '.claude.json': entry({ SLACKLINE_CHANNEL_ONLY: '1' }) });
  assert.equal(await I.main(['install', 'claude'], a.c), 1);
  assert.equal(await I.main(['uninstall', 'claude'], a.c), 0);
  assert.deepEqual(a.calls, []);

  const out = capture(t);
  const b = sandbox(t, { '.claude.json': entry({ SLACKLINE_REMOTE_ONLY: '1', SLACKLINE_ROUTES: '1', SLACKLINE_CHANNEL: '1' }) });
  assert.equal(await I.main(['install', 'claude'], b.c), 0);
  assert.deepEqual(b.calls, []);
  assert.ok(out.some(l => /^unchanged\s+Claude Code/.test(l)));
  assert.equal(await I.main(['uninstall', 'claude'], b.c), 0);
  assert.deepEqual(b.calls, ['claude mcp remove -s user slackline']);
});

test('a repo path with a quote, a double quote and a backslash installs idempotently and uninstalls cleanly', () => {
  const odd = { node: '/usr/bin/node', repo: '/tmp/it\'s "odd"\\ repo' };
  const cases = [
    [I.codexHooks, I.unCodexHooks, '', (s) => JSON.parse(s), {}],
    [I.opencodeJson, I.unOpencodeJson, '{"model":"m"}', (s) => JSON.parse(s), { model: 'm' }],
    [I.museSettings, I.unMuseSettings, '{"a":1}', (s) => JSON.parse(s), { a: 1 }],
    [I.bashrc, I.unBashrc, 'export A=1\n', (s) => s, 'export A=1\n'],
  ];
  for (const [fwd, back, seed, norm, want] of cases) {
    const once = fwd(seed, odd);
    assert.notEqual(once, seed, fwd.name);
    assert.equal(fwd(once, odd), once, `${fwd.name} idempotent`);
    assert.deepEqual(norm(back(once, odd)), want, `${back.name} removes it`);
  }
});

test('a hook group holding someone else\'s command beside ours is theirs: install appends ours separately, uninstall leaves it', () => {
  const ours = "'/opt/slackline/agents/hook.sh' start --agent codex";
  const mixed = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ours }, { type: 'command', command: '/their/hook' }] }] } };
  const out = JSON.parse(I.codexHooks(JSON.stringify(mixed), at));
  assert.equal(out.hooks.SessionStart.length, 2);
  assert.deepEqual(out.hooks.SessionStart[0], mixed.hooks.SessionStart[0]);
  assert.deepEqual(out.hooks.SessionStart[1], { hooks: [{ type: 'command', command: ours }] });
  assert.deepEqual(JSON.parse(I.unCodexHooks(JSON.stringify(out), at)), mixed);
  assert.equal(I.unCodexHooks(JSON.stringify(mixed), at), JSON.stringify(mixed));
  assert.throws(() => I.codexHooks('{"hooks":{"SessionStart":{}}}', at), /not a list/);
});

test('install codex with a commented hooks.json leaves config.toml alone, with no backup', async (t) => {
  const withBlock = EXISTING['.codex/config.toml'] + '\n' + OLD_BLOCK;
  const { c, calls, codex, read, has } = sandbox(t, { ...EXISTING, '.codex/config.toml': withBlock, '.codex/hooks.json': '{\n  // mine\n}\n' }, null, { servers: [OURS] });
  assert.equal(await I.main(['install', 'codex'], c), 1);
  assert.equal(read('.codex/config.toml'), withBlock, 'the old block is not migrated when the target is refused');
  assert.ok(!has('.codex/config.toml.bak-slackline-STAMP'));
  assert.equal(read('.codex/hooks.json'), '{\n  // mine\n}\n');
  assert.deepEqual(calls, ['codex mcp list --json'], 'and nothing is registered');
  assert.deepEqual(codex.servers, [OURS]);
});

// ---- Codex: the tools registration goes through `codex mcp`, never through config.toml ----

const CODEX_ADD = 'codex mcp add slackline --env SLACKLINE_REMOTE_ONLY=1 -- /usr/bin/node /opt/slackline/mcp.mjs';

test('Codex: an old marker block is migrated — removed with a backup, then registered through the CLI', async (t) => {
  const withBlock = EXISTING['.codex/config.toml'] + '\n' + OLD_BLOCK;
  // While the block is in the file, Codex reports the registration it holds.
  const { c, calls, read, has } = sandbox(t, { '.codex/config.toml': withBlock },
    async (cmd, args) => (cmd === 'codex' && args[1] === 'list' ? { code: 0, stdout: JSON.stringify([OURS]), stderr: '' } : null));
  const out = capture(t);
  assert.equal(await I.main(['install', 'codex'], c), 0);
  assert.equal(read('.codex/config.toml'), EXISTING['.codex/config.toml'], 'the block is gone and nothing else moved');
  assert.equal(read('.codex/config.toml.bak-slackline-STAMP'), withBlock);
  assert.match(read('.codex/hooks.json'), /hook\.sh' start --agent codex/);
  assert.deepEqual(calls, ['codex mcp list --json', CODEX_ADD], 'dropping the block dropped the registration, so it is added, not removed first');
  const edited = out.findIndex(l => /^updated\s+.*config\.toml$/.test(l)), added = out.findIndex(l => /^created\s+Codex MCP server "slackline"$/.test(l));
  assert.ok(edited >= 0 && added > edited, out.join('\n'));
});

test('Codex: a registration of ours that is already right runs no add or remove; an old node path is replaced', async (t) => {
  const out = capture(t);
  const a = sandbox(t, {}, null, { servers: [OURS] });
  assert.equal(await I.main(['install', 'codex'], a.c), 0);
  assert.deepEqual(a.calls, ['codex mcp list --json']);
  assert.ok(out.some(l => /^unchanged\s+Codex MCP server "slackline"$/.test(l)), out.join('\n'));
  assert.ok(!a.has('.codex/config.toml'), 'no config.toml is created');

  const b = sandbox(t, {}, null, { servers: [server('slackline', '/old/node', [MCP], { SLACKLINE_REMOTE_ONLY: '1' })] });
  assert.equal(await I.main(['install', 'codex'], b.c), 0);
  assert.deepEqual(b.calls, ['codex mcp list --json', 'codex mcp remove slackline', CODEX_ADD]);
  assert.deepEqual(b.codex.servers, [OURS]);
  assert.ok(out.some(l => /^updated\s+Codex MCP server "slackline"$/.test(l)), out.join('\n'));

  const noEnv = sandbox(t, {}, null, { servers: [server('slackline', '/usr/bin/node', [MCP])] });
  assert.equal(await I.main(['install', 'codex'], noEnv.c), 0);
  assert.deepEqual(noEnv.calls, ['codex mcp list --json', 'codex mcp remove slackline', CODEX_ADD], 'ours without the env is brought up to date');
});

test('Codex: someone else\'s "slackline" registration is refused with nothing changed, and left on uninstall', async (t) => {
  const foreign = {
    'a different script': server('slackline', '/usr/bin/node', ['/elsewhere/mcp.mjs'], { SLACKLINE_REMOTE_ONLY: '1' }),
    'a further script argument': server('slackline', '/usr/bin/node', [MCP, '--verbose'], { SLACKLINE_REMOTE_ONLY: '1' }),
    'an env key we do not write': server('slackline', '/usr/bin/node', [MCP], { SLACKLINE_REMOTE_ONLY: '1', SLACKLINE_CHANNEL_ONLY: '1' }),
    'not a command at all': { name: 'slackline', enabled: true, transport: { type: 'streamable_http', url: 'https://example.invalid/mcp' } },
  };
  for (const [name, entry] of Object.entries(foreign)) {
    const out = capture(t);
    const { c, calls, codex, read, has } = sandbox(t, { '.codex/config.toml': EXISTING['.codex/config.toml'] }, null, { servers: [entry] });
    assert.equal(await I.main(['install', 'codex'], c), 1, name);
    assert.deepEqual(calls, ['codex mcp list --json'], name);
    assert.deepEqual(codex.servers, [entry], name);
    assert.ok(!has('.codex/hooks.json'), `${name}: the hooks are not written either`);
    assert.equal(read('.codex/config.toml'), EXISTING['.codex/config.toml'], name);
    assert.ok(out.some(l => /FAILED\s+codex: Codex already has a different MCP server named "slackline"/.test(l)), out.join('\n'));
    assert.equal((await I.inspect(c)).codex.tools, false, `${name}: not reported as our tools`);
    calls.length = 0;
    assert.equal(await I.main(['uninstall', 'codex'], c), 0, name);
    assert.deepEqual(calls, ['codex mcp list --json'], `${name}: uninstall does not remove it`);
    assert.deepEqual(codex.servers, [entry], name);
    t.mock.restoreAll();
  }
});

test('Codex: a damaged old block fails the target and leaves config.toml byte-identical', async (t) => {
  const out = capture(t);
  const { c, calls, codex, read, has } = sandbox(t, { '.codex/config.toml': REWRITTEN }, null, { servers: [OURS] });
  assert.equal(await I.main(['install', 'codex'], c), 1);
  assert.equal(read('.codex/config.toml'), REWRITTEN);
  assert.ok(!has('.codex/config.toml.bak-slackline-STAMP') && !has('.codex/hooks.json'));
  assert.deepEqual(calls, ['codex mcp list --json']);
  assert.deepEqual(codex.servers, [OURS]);
  assert.ok(out.some(l => /FAILED\s+codex: .*line 15: # <<< slackline <<<.*delete that line by hand/.test(l)), out.join('\n'));
  calls.length = 0;
  assert.equal(await I.main(['uninstall', 'codex'], c), 1, 'uninstall does not guess either');
  assert.equal(read('.codex/config.toml'), REWRITTEN);
  assert.deepEqual(calls, ['codex mcp list --json'], 'only the read-only list ran');
  assert.deepEqual(codex.servers, [OURS]);
});

// Two different failures, worded differently: the command could not be run, or it ran and its
// output was not the JSON list.
const UNREADABLE = {
  'exit 2': [{ code: 2, stdout: '', stderr: 'boom\n' }, /the codex command could not be run \(boom\)/],
  'spawn ENOENT': [{ code: 1, stdout: '', stderr: 'spawn ENOENT' }, /the codex command could not be run \(spawn ENOENT\)/],
  'a notice before the JSON': [{ code: 0, stdout: 'Update available\n[]\n', stderr: '' }, /output of `codex mcp list --json` was not the expected JSON list \(it began: Update available\)/],
  'not a list': [{ code: 0, stdout: '{"a":1}', stderr: '' }, /was not the expected JSON list/],
};

test('Codex install: when the registrations cannot be read, nothing is written and the message says which failure it was', async (t) => {
  const withBlock = EXISTING['.codex/config.toml'] + '\n' + OLD_BLOCK;
  for (const [why, [reply, msg]] of Object.entries(UNREADABLE)) {
    const out = capture(t);
    const { c, calls, read, has } = sandbox(t, { '.codex/config.toml': withBlock }, async () => reply);
    assert.equal(await I.main(['install', 'codex'], c), 1, why);
    assert.deepEqual(calls, ['codex mcp list --json'], why);
    assert.equal(read('.codex/config.toml'), withBlock, why);
    assert.ok(!has('.codex/config.toml.bak-slackline-STAMP') && !has('.codex/hooks.json'), why);
    assert.ok(out.some(l => /^FAILED\s+codex: /.test(l) && msg.test(l)), `${why}: ${out.join('\n')}`);
    t.mock.restoreAll();
  }
});

test('Codex uninstall: when the registrations cannot be read it fails before editing any file and leaves the registration', async (t) => {
  const withBlock = EXISTING['.codex/config.toml'] + '\n' + OLD_BLOCK, hooks = I.codexHooks('', at);
  for (const [why, [reply, msg]] of Object.entries(UNREADABLE)) {
    const out = capture(t);
    const { c, calls, read, has } = sandbox(t, { '.codex/config.toml': withBlock, '.codex/hooks.json': hooks }, async () => reply);
    assert.equal(await I.main(['uninstall', 'codex'], c), 1, why);
    assert.deepEqual(calls, ['codex mcp list --json'], why);
    assert.equal(read('.codex/config.toml'), withBlock, why);
    assert.equal(read('.codex/hooks.json'), hooks, why);
    assert.ok(!has('.codex/config.toml.bak-slackline-STAMP'), why);
    assert.ok(out.some(l => /^FAILED\s+codex: /.test(l) && msg.test(l) && /left in place/.test(l)), `${why}: ${out.join('\n')}`);
    t.mock.restoreAll();
  }
});

test('Codex: uninstall removes an old block, our hooks and our registration', async (t) => {
  const withBlock = EXISTING['.codex/config.toml'] + '\n' + OLD_BLOCK;
  const a = sandbox(t, EXISTING, null, { servers: [server('other', 'x', [])] });
  await I.main(['install', 'codex'], a.c);
  a.calls.length = 0;
  assert.equal(await I.main(['uninstall', 'codex'], a.c), 0);
  assert.deepEqual(a.calls, ['codex mcp list --json', 'codex mcp remove slackline']);
  assert.deepEqual(a.codex.servers.map(s => s.name), ['other']);
  assert.deepEqual(JSON.parse(a.read('.codex/hooks.json')), {});
  assert.equal(a.read('.codex/config.toml.bak-slackline-STAMP'), EXISTING['.codex/config.toml'], 'config.toml is backed up before codex mcp remove');

  // An old block IS the registration Codex reported: dropping it needs no `codex mcp remove`.
  const hooks = I.codexHooks('', at);
  const b = sandbox(t, { '.codex/config.toml': withBlock, '.codex/hooks.json': hooks }, async (cmd, args) => (args[1] === 'list' ? { code: 0, stdout: JSON.stringify([OURS]), stderr: '' } : null));
  assert.equal(await I.main(['uninstall', 'codex'], b.c), 0);
  assert.equal(b.read('.codex/config.toml'), EXISTING['.codex/config.toml']);
  assert.equal(b.read('.codex/config.toml.bak-slackline-STAMP'), withBlock);
  assert.deepEqual(JSON.parse(b.read('.codex/hooks.json')), {});
  assert.deepEqual(b.calls, ['codex mcp list --json']);
});

test('Codex: config.toml is backed up once, only if it exists, just before the first codex mcp add/remove', async (t) => {
  // replace path: remove then add, one backup, taken before the remove
  const a = sandbox(t, { '.codex/config.toml': 'x = 1\n' }, null, { servers: [server('slackline', '/old/node', [MCP], { SLACKLINE_REMOTE_ONLY: '1' })] });
  const seen = [];
  const before = a.c.run;
  a.c.run = async (cmd, args, o) => { seen.push([args.slice(0, 2).join(' '), a.has('.codex/config.toml.bak-slackline-STAMP')]); return before(cmd, args, o); };
  assert.equal(await I.main(['install', 'codex'], a.c), 0);
  assert.deepEqual(seen, [['mcp list', false], ['mcp remove', true], ['mcp add', true]]);
  assert.equal(a.read('.codex/config.toml.bak-slackline-STAMP'), 'x = 1\n');
  // no config.toml: nothing to back up and nothing created
  const b = sandbox(t, {});
  assert.equal(await I.main(['install', 'codex'], b.c), 0);
  assert.ok(!b.has('.codex/config.toml') && !b.has('.codex/config.toml.bak-slackline-STAMP'));
  // already right: no add/remove, so no backup
  const c2 = sandbox(t, { '.codex/config.toml': 'x = 1\n' }, null, { servers: [OURS] });
  assert.equal(await I.main(['install', 'codex'], c2.c), 0);
  assert.ok(!c2.has('.codex/config.toml.bak-slackline-STAMP'));
  // Claude Code's ~/.claude.json is not backed up
  const d = sandbox(t, { '.claude.json': JSON.stringify({ mcpServers: { slackline: { command: '/old/node', args: [MCP], env: { SLACKLINE_CHANNEL: '1', SLACKLINE_ROUTES: '1', SLACKLINE_REMOTE_ONLY: '1' } } } }) });
  assert.equal(await I.main(['install', 'claude'], d.c), 0);
  assert.ok(!d.has('.claude.json.bak-slackline-STAMP'));
});

test('a completed removal is reported as its own step when the following add fails (Codex and Claude Code)', async (t) => {
  const out = capture(t);
  const a = sandbox(t, { '.codex/config.toml': 'x = 1\n' }, async (cmd, args) => (cmd === 'codex' && args[1] === 'add' ? { code: 1, stdout: '', stderr: 'add exploded\n' } : null),
    { servers: [server('slackline', '/old/node', [MCP], { SLACKLINE_REMOTE_ONLY: '1' })] });
  assert.equal(await I.main(['install', 'codex'], a.c), 1);
  const removed = out.findIndex(l => /^removed\s+Codex MCP server "slackline" \(replacing\)$/.test(l)), failed = out.findIndex(l => /^FAILED\s+codex: codex mcp add failed: add exploded/.test(l));
  assert.ok(removed >= 0 && failed > removed, out.join('\n'));
  assert.deepEqual(a.codex.servers, [], 'the registration really is gone');
  t.mock.restoreAll();

  const out2 = capture(t);
  const ours = { mcpServers: { slackline: { command: '/old/node', args: [MCP], env: { SLACKLINE_CHANNEL: '1', SLACKLINE_ROUTES: '1', SLACKLINE_REMOTE_ONLY: '1' } } } };
  const b = sandbox(t, { '.claude.json': JSON.stringify(ours) }, async (cmd, args) => (cmd === 'claude' && args[1] === 'add' ? { code: 1, stdout: '', stderr: 'add exploded\n' } : null));
  assert.equal(await I.main(['install', 'claude'], b.c), 1);
  const removed2 = out2.findIndex(l => /^removed\s+Claude Code user-scope MCP server "slackline" \(replacing\)$/.test(l)), failed2 = out2.findIndex(l => /^FAILED\s+claude: claude mcp add failed: add exploded/.test(l));
  assert.ok(removed2 >= 0 && failed2 > removed2, out2.join('\n'));
});

test('Codex: a registration that passes environment through env_vars is not ours', async (t) => {
  const withVars = { ...OURS, transport: { ...OURS.transport, env_vars: ['SECRET_TOKEN'] } };
  const out = capture(t);
  const { c, calls, codex } = sandbox(t, {}, null, { servers: [withVars] });
  assert.equal(await I.main(['install', 'codex'], c), 1);
  assert.deepEqual(codex.servers, [withVars]);
  assert.ok(out.some(l => /FAILED\s+codex: Codex already has a different MCP server named "slackline"/.test(l)));
  assert.equal((await I.inspect(c)).codex.tools, false);
  calls.length = 0;
  assert.equal(await I.main(['uninstall', 'codex'], c), 0);
  assert.deepEqual(calls, ['codex mcp list --json'], 'and uninstall leaves it');
  // other fields stay ignored
  const other = { ...OURS, enabled: false, startup_timeout_sec: 30, transport: { ...OURS.transport, cwd: '/somewhere' } };
  assert.equal((await I.inspect(sandbox(t, {}, null, { servers: [other] }).c)).codex.tools, true);
});

test('Codex: a repo path with a quote, a double quote and a backslash installs idempotently and uninstalls cleanly', async (t) => {
  const repo = '/tmp/it\'s "odd"\\ repo';
  const { c, calls, codex, read } = sandbox(t, {}, null, { repo });
  assert.equal(await I.main(['install', 'codex'], c), 0);
  assert.deepEqual(codex.servers, [server('slackline', '/usr/bin/node', [`${repo}/mcp.mjs`], { SLACKLINE_REMOTE_ONLY: '1' })], 'the path reaches codex as one argument, unquoted');
  const hooks = read('.codex/hooks.json');
  calls.length = 0;
  assert.equal(await I.main(['install', 'codex'], c), 0);
  assert.deepEqual(calls, ['codex mcp list --json']);
  assert.equal(read('.codex/hooks.json'), hooks);
  assert.equal((await I.inspect(c)).codex.tools, true);
  assert.equal(await I.main(['uninstall', 'codex'], c), 0);
  assert.deepEqual(codex.servers, []);
  assert.deepEqual(JSON.parse(read('.codex/hooks.json')), {});
});

test('install muse when the muse command is unavailable creates nothing', async (t) => {
  const { c, has, calls } = sandbox(t, {}, async () => ({ code: 1, stdout: '', stderr: 'spawn ENOENT' }));
  const out = capture(t);
  assert.equal(await I.main(['install', 'muse'], c), 1);
  assert.ok(!has('.config/muse/settings.json'));
  assert.deepEqual(calls, ['muse plugins list --json']);
  assert.ok(out.some(l => /FAILED\s+muse: the muse command is not available/.test(l)));
});

test('the shell target checks the csl link before writing .bashrc: a refusal writes nothing', async (t) => {
  const out = capture(t);
  const { home, c, has } = sandbox(t, { '.bashrc': 'export A=1\n' });
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync('/somewhere/else', join(home, '.local/bin/csl'));
  assert.equal(await I.main(['install', 'shell'], c), 1);
  assert.ok(out.some(l => /^FAILED\s+shell:.*somewhere else/.test(l)), out.join('\n'));
  assert.ok(!out.some(l => /^(updated|created)\s+.*\.bashrc$/.test(l)), 'nothing was reported written');
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), 'export A=1\n', '.bashrc untouched');
  assert.ok(!has('.bashrc.bak-slackline-STAMP'));
  assert.equal(readlinkSync(join(home, '.local/bin/csl')), '/somewhere/else');
});

test('a config that cannot be read, or is not UTF-8, is refused and left untouched', async (t) => {
  const a = sandbox(t, {});
  mkdirSync(join(a.home, '.codex/config.toml'), { recursive: true }); // reading it fails with EISDIR, not ENOENT
  assert.equal(await I.main(['install', 'codex'], a.c), 1);
  assert.ok(!a.has('.codex/hooks.json'), 'nothing of the target is written');

  const bytes = Buffer.from([0x65, 0x78, 0xff, 0xfe, 0x0a]);
  const b = sandbox(t, { '.bashrc': bytes });
  assert.equal(await I.main(['install', 'shell'], b.c), 1);
  assert.deepEqual(readFileSync(join(b.home, '.bashrc')), bytes);
  assert.ok(!b.has('.bashrc.bak-slackline-STAMP'));
});

test('a foreign plugin/slackline.js is refused on install and left on uninstall', async (t) => {
  const mine = 'export const mine = 1;\n';
  const { c, read, has } = sandbox(t, { '.config/opencode/plugin/slackline.js': mine });
  assert.equal(await I.main(['install', 'opencode'], c), 1);
  assert.equal(read('.config/opencode/plugin/slackline.js'), mine);
  assert.ok(!has('.config/opencode/opencode.json'), 'the config is not written either');
  assert.equal(await I.main(['uninstall', 'opencode'], c), 0);
  assert.equal(read('.config/opencode/plugin/slackline.js'), mine);
});

test('Muse uninstall disables the plugin only when it is installed', async (t) => {
  const a = sandbox(t, {});
  assert.equal(await I.main(['uninstall', 'muse'], a.c), 0);
  assert.deepEqual(a.calls, ['muse plugins list --json']);
  const b = sandbox(t, {}, async (cmd, args) => ({ code: 0, stdout: args[1] === 'list' ? '[{"id":"slackline"}]' : '', stderr: '' }));
  assert.equal(await I.main(['uninstall', 'muse'], b.c), 0);
  assert.deepEqual(b.calls, ['muse plugins list --json', 'muse plugins disable slackline --json']);
});

const MUSE_SETTINGS_OURS = JSON.stringify({ mcpServers: { slackline: { mode: 'optional', command: '/usr/bin/node', args: [MCP], env: { SLACKLINE_REMOTE_ONLY: '1' } } } }, null, 2) + '\n';

test('Muse uninstall fails, before editing anything, when `muse plugins list` cannot be run or read', async (t) => {
  const cases = [
    ['cannot be run', { code: 1, stdout: '', stderr: 'spawn ENOENT' }, /muse command could not be run \(spawn ENOENT\)/],
    ['not the expected output', { code: 0, stdout: 'Error: update available\n', stderr: '' }, /not the expected JSON \(it began: Error: update available\)/],
  ];
  for (const [name, reply, message] of cases) {
    const out = capture(t);
    const { c, read, calls } = sandbox(t, { '.config/muse/settings.json': MUSE_SETTINGS_OURS }, async (cmd, args) => (cmd === 'muse' ? reply : null));
    assert.equal(await I.main(['uninstall', 'muse'], c), 1, name);
    assert.ok(out.some(l => /^FAILED\s+muse:/.test(l) && message.test(l)), `${name}: ${out.join('\n')}`);
    assert.equal(read('.config/muse/settings.json'), MUSE_SETTINGS_OURS, `${name}: settings.json untouched`);
    assert.deepEqual(calls, ['muse plugins list --json']);
  }
});

test('Muse uninstall fails when `muse plugins disable` exits non-zero', async (t) => {
  const out = capture(t);
  const { c } = sandbox(t, {}, async (cmd, args) => (args[1] === 'list' ? { code: 0, stdout: '[{"id":"slackline"}]', stderr: '' }
    : { code: 3, stdout: '', stderr: 'error: plugin is locked\nmore\n' }));
  assert.equal(await I.main(['uninstall', 'muse'], c), 1);
  assert.ok(out.some(l => /^FAILED\s+muse: muse plugins disable failed: error: plugin is locked$/.test(l)), out.join('\n'));
  assert.ok(!out.some(l => /disabled/.test(l)), 'never reported as disabled');
});

test('a delivery mode written with quotes survives a re-run of agentsEnv', () => {
  const out = I.agentsEnv('SLACKLINE_DELIVER_MUSE="tmux"\nSLACKLINE_DELIVER_CODEX=\'tmux\'\n', at);
  assert.match(out, /^SLACKLINE_DELIVER_MUSE=tmux$/m);
  assert.match(out, /^SLACKLINE_DELIVER_CODEX=tmux$/m);
});

test('status shows live listener counts per agent', async (t) => {
  const { home, c } = sandbox(t, {});
  mkdirSync(join(home, '.slackline/run'), { recursive: true });
  writeFileSync(join(home, '.slackline/run/codex-T-1.pid'), String(process.pid));
  writeFileSync(join(home, '.slackline/run/muse-S-2.pid'), '4999999');
  const text = await I.status(c, home);
  assert.match(text, /^codex\s+.*listeners: 1$/m);
  assert.match(text, /^muse\s+.*listeners: 0$/m);
});

test('status warns about every workspace in routes.json that the hub does not serve', async (t) => {
  const hub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, orgs_live: ['acme', 'globex'] })); });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  t.after(() => hub.close());
  const routes = JSON.stringify({ defaults: [{ org: 'acme', channels: ['D1'] }, { org: 'acmee', channels: ['D2'] }],
    routes: [{ dir: '/x', org: 'globex', channels: ['C1'] }, { dir: '/y', org: 'globexx', channels: ['C2'] }] });
  const { home } = sandbox(t, { '.slackline/routes.json': routes });
  const c = I.context({ home, node: at.node, repo: at.repo, stamp: 'S', env: { SLACKLINE_REMOTE: `http://127.0.0.1:${hub.address().port}`, SLACKLINE_SECRET: 's' },
    runImpl: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  const lines = (await I.status(c, home)).split('\n');
  const warn = lines.filter(l => /WARNING/.test(l));
  assert.deepEqual(warn, [
    'route      WARNING — routes.json names workspace "acmee", which the hub does not serve',
    'route      WARNING — routes.json names workspace "globexx", which the hub does not serve']);
  assert.match(lines[0], /^hub\s+ok/);
  assert.equal(lines.indexOf(warn[0]), 1, 'the warnings follow the hub line');
});

test('agentsEnv keeps lines the operator added, in order, after its own; a re-run changes nothing', () => {
  const first = I.agentsEnv('', at);
  const edited = first.replace('SLACKLINE_DELIVER_MUSE=tmux\n', 'SLACKLINE_DELIVER_MUSE=tmux\nSLACKLINE_HOOK_DEBUG=1\n# mine\nFOO=bar\n');
  const again = I.agentsEnv(edited, at);
  assert.match(again, /SLACKLINE_DELIVER_MUSE=tmux\nSLACKLINE_HOOK_DEBUG=1\n# mine\nFOO=bar\n$/);
  assert.equal(again.split('\n').filter(l => l.startsWith('# Written by')).length, 1, 'the header is not duplicated');
  assert.equal(again.match(/^SLACKLINE_REPO=/gm).length, 1);
  assert.equal(I.agentsEnv(again, at), again, 'idempotent');
  // moving the operator's lines above the installer's own does not reorder them relative to each other
  assert.match(I.agentsEnv('Z=1\nSLACKLINE_REPO=old\nA=2\n', at), /\nZ=1\nA=2\n$/);
});

test('agents.env is written 0600, and a wider existing file is narrowed', async (t) => {
  const { home, c, context } = sandbox(t, {});
  assert.equal(await I.main(['install', 'shell'], c), 0);
  const f = join(home, '.slackline/agents.env');
  assert.equal(lstatSync(f).mode & 0o777, 0o600);
  chmodSync(f, 0o644);
  assert.equal(await I.main(['install', 'shell'], context('SECOND')), 0, 'unchanged text, wider mode');
  assert.equal(lstatSync(f).mode & 0o777, 0o600);
});

test('uninstall names live listeners and how to stop them, and does not kill them', async (t) => {
  const out = capture(t);
  const { home, c } = sandbox(t, {});
  mkdirSync(join(home, '.slackline/run'), { recursive: true });
  writeFileSync(join(home, '.slackline/run/codex-T-1.pid'), String(process.pid));
  writeFileSync(join(home, '.slackline/run/muse-S-2.pid'), '4999999');
  assert.equal(await I.main(['uninstall', 'shell'], c), 0);
  const note = out.filter(l => /listener/.test(l));
  assert.equal(note.length, 1);
  assert.match(note[0], new RegExp(`codex-T-1 \\(pid ${process.pid}\\)`));
  assert.match(note[0], new RegExp(`kill ${process.pid}$`));
  assert.ok(!/muse-S-2/.test(note[0]), 'a dead pid is not a live listener');
  assert.ok(existsSync(join(home, '.slackline/run/codex-T-1.pid')), 'nothing was removed or killed');
  out.length = 0;
  rmSync(join(home, '.slackline/run/codex-T-1.pid'));
  await I.main(['uninstall', 'shell'], c);
  assert.ok(!out.some(l => /listener/.test(l)), 'silent when there are none');
});

test('status shows tools: OTHER, and one note, for a "slackline" registration that is not this checkout\'s', async (t) => {
  const moved = JSON.stringify({ mcpServers: { slackline: { command: '/usr/bin/node', args: ['/old/place/mcp.mjs'] } } });
  const { home, c } = sandbox(t, { '.claude.json': moved, '.config/muse/settings.json': MUSE_SETTINGS_OURS.replace(MCP, '/old/place/mcp.mjs') });
  const text = await I.status(c, home);
  assert.match(text, /^claude\s+tools: OTHER/m);
  assert.match(text, /^muse\s+tools: OTHER/m);
  assert.match(text, /^opencode\s+tools: NO/m);
  const notes = text.split('\n').filter(l => l.startsWith('note'));
  assert.deepEqual(notes, ['note       a "slackline" entry that is not this checkout\'s exists for: claude, muse — if the checkout was moved, uninstall from the old path or remove it by hand']);
  const clean = await I.status(sandbox(t, {}).c, home);
  assert.ok(!/OTHER|^note/m.test(clean));
});
