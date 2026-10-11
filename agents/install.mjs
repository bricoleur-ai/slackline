// `slackline agents install|status|uninstall [target…]` — wires slackline into the coding
// agents on this machine: tools everywhere, plus each agent's native push (docs/agents.md).
//
// This edits other programs' config files, so it keeps three promises:
//   1. idempotent — running it twice changes nothing the second time;
//   2. reversible — every file is backed up before its first edit (<file>.bak-slackline-<stamp>)
//      and `uninstall` removes exactly what `install` added. "Ours" is decided from parsed
//      values (the exact script path, the exact env keys, the exact hook group), never from a
//      substring, so a hand-written entry is never replaced or removed;
//   3. it refuses rather than guesses — a config it cannot read, decode or parse, or one that
//      already has a hand-written `slackline` entry, is left byte-for-byte alone and reported.
//      A target computes every new file text before writing any of them, so a refusal never
//      leaves it half-installed; each step that does complete is reported as it happens.
//
// Each edit is a pure function from the file's current text to its new text (the first half of
// this file); the apply layer (the second half) only reads, backs up and writes. No hub key is
// ever written to an agent's config: registrations name mcp.mjs, which reads
// ~/.slackline/config.json itself.
//
// Two agents rewrite their own config file, so their tools registration is never edited there:
// it goes through the agent's CLI (`claude mcp …`, `codex mcp …`), after reading what is
// registered now. Claude Code's ~/.claude.json is rewritten continuously by Claude Code itself,
// so what `claude mcp` writes there has no backup of ours. Codex's ~/.codex/config.toml is a
// hand-maintained file, so it is backed up (once per run, if it exists) just before the first
// `codex mcp add` or `codex mcp remove`.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { remoteConfig, whoami } from '../remote.mjs';
import { resolve as resolveRoute, loadRoutes } from './route.mjs';
import { run } from './deliver.mjs';
import { alive } from './listen.mjs';

export const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = ['shell', 'claude', 'opencode', 'codex', 'muse'];
const BEGIN = '# >>> slackline >>>', END = '# <<< slackline <<<';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 200);
const same = isDeepStrictEqual; // key order is not meaning
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const mcpPath = (repo) => join(repo, 'mcp.mjs');
const hookPath = (repo) => join(repo, 'agents', 'hook.sh');
// An MCP entry is ours only when it runs exactly this repo's mcp.mjs (no further arguments)
// and its env uses only keys this installer writes. The node path may differ (an upgraded
// node still counts). Anything else named `slackline` is the operator's: never replaced, never
// removed. Compared as parsed values, so a repo path with quotes or backslashes is no problem.
const envWithin = (env, allowed) => env === undefined || (isObj(env) && Object.keys(env).every(k => allowed.includes(k)));
const OC_ENV = ['SLACKLINE_REMOTE_ONLY'], CLAUDE_ENV = ['SLACKLINE_CHANNEL', 'SLACKLINE_ROUTES', 'SLACKLINE_REMOTE_ONLY'];
const ocOurs = (e, repo) => isObj(e) && Array.isArray(e.command) && e.command.length === 2 && e.command[1] === mcpPath(repo) && envWithin(e.environment, OC_ENV);
const argsOurs = (allowed) => (e, repo) => isObj(e) && Array.isArray(e.args) && e.args.length === 1 && e.args[0] === mcpPath(repo) && envWithin(e.env, allowed);
const museOurs = argsOurs(OC_ENV), claudeOurs = argsOurs(CLAUDE_ENV);
// A Codex registration as `codex mcp list --json` reports it: the same rule, one level down.
// `env_vars` is a second way to pass environment: a registration that uses it is not ours.
const noEnvVars = (v) => v == null || (Array.isArray(v) && v.length === 0);
const codexOurs = (e, repo) => isObj(e) && isObj(e.transport) && noEnvVars(e.transport.env_vars)
  && museOurs({ args: e.transport.args, env: e.transport.env ?? undefined }, repo);
// See mcp.mjs: a machine-wide registration must not fall back to local mode.
const REMOTE_ONLY = { SLACKLINE_REMOTE_ONLY: '1' };

// ---------- pure transforms: current file text -> new file text ----------

// A marker-delimited block, for formats we will not parse (TOML, shell). No TOML library is
// needed, and removal is exact.
export function dropBlock(text) {
  const i = text.indexOf(BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(END, i);
  if (j < 0) throw new Error('found a slackline marker block with no end marker — fix the file by hand');
  return text.slice(0, i).replace(/\n\n$/, '\n') + text.slice(j + END.length).replace(/^\n/, '');
}
export function setBlock(text, body) {
  const rest = dropBlock(text);
  const gap = !rest ? '' : rest.endsWith('\n') ? '\n' : '\n\n';
  return `${rest}${gap}${BEGIN}\n${body.trimEnd()}\n${END}\n`;
}

function parseJson(text, what) {
  if (!text.trim()) return {};
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${what} is not plain JSON (comments, or a syntax error?) — not touching it`);
  return j;
}
const dump = (j) => JSON.stringify(j, null, 2) + '\n';

// Put our entry at j[section].slackline. Returns the text untouched when it is already there,
// so a re-run does not reformat the operator's file.
function putEntry(text, what, section, want, ours, repo) {
  const j = parseJson(text, what);
  const cur = j[section] && j[section].slackline;
  if (cur && !ours(cur, repo)) throw new Error(`${what} already has a different "${section}.slackline" entry — remove it first, or leave this agent's tools as they are`);
  if (same(cur, want)) return text;
  return dump({ ...j, [section]: { ...(j[section] || {}), slackline: want } });
}
function dropEntry(text, what, section, ours, repo) {
  if (!text.trim()) return text;
  const j = parseJson(text, what);
  if (!isObj(j[section]) || !ours(j[section].slackline, repo)) return text;
  const { slackline, ...others } = j[section];
  const next = { ...j, [section]: others };
  if (!Object.keys(others).length) delete next[section];
  return dump(next);
}

export const opencodeJson = (text, { node, repo }) => putEntry(text, 'opencode.json', 'mcp',
  { type: 'local', command: [node, mcpPath(repo)], environment: REMOTE_ONLY, enabled: true }, ocOurs, repo);
export const unOpencodeJson = (text, { repo }) => dropEntry(text, 'opencode.json', 'mcp', ocOurs, repo);

export const museSettings = (text, { node, repo }) => putEntry(text, 'Muse settings.json', 'mcpServers',
  { mode: 'optional', command: node, args: [mcpPath(repo)], env: REMOTE_ONLY }, museOurs, repo);
export const unMuseSettings = (text, { repo }) => dropEntry(text, 'Muse settings.json', 'mcpServers', museOurs, repo);

// OpenCode calls every export of a plugin file as a plugin, so this re-exports exactly one name.
export const opencodePlugin = ({ repo }) =>
  '// Written by `slackline agents install opencode`; remove with `slackline agents uninstall opencode`.\n'
  + `export { SlacklinePlugin } from ${JSON.stringify(join(repo, 'agents', 'opencode', 'plugin.mjs'))};\n`;

// Codex's registration is never kept in a marker block in ~/.codex/config.toml. Codex rewrites
// that file itself: `codex mcp add` (0.160.1) dropped the opening marker, moved the table and
// left the closing marker orphaned on the last line. So such a block is never written, only
// removed — and only when it is whole. Any other combination of marker lines is
// not ours to guess at: the file is left alone and the operator is told which lines to delete
// (the table those lines no longer mark is then judged like any other registration).
const OLD_BLOCK_LINE = [/^\s*$/, /^# Managed by /, /^\[mcp_servers\.slackline\]\s*$/, /^command\s*=/, /^args\s*=\s*\[.*\]\s*$/, /^env\s*=\s*\{.*\}\s*$/];
export function dropCodexBlock(text) {
  const marks = [];
  for (const m of [BEGIN, END]) for (let i = text.indexOf(m); i >= 0; i = text.indexOf(m, i + 1)) marks.push([i, m]);
  if (!marks.length) return text;
  marks.sort((a, b) => a[0] - b[0]);
  if (marks.length === 2 && marks[0][1] === BEGIN && marks[1][1] === END) {
    // Only what the old installer wrote may be removed with it: anything else a person (or
    // Codex) put between the markers is theirs.
    const start = marks[0][0] + BEGIN.length, body = text.slice(start, marks[1][0]).split('\n');
    const foreign = body.findIndex((l, k) => k > 0 && !OLD_BLOCK_LINE.some(re => re.test(l)));
    if (foreign >= 0) throw new Error(`config.toml has a slackline marker block with something else inside it (line ${text.slice(0, start).split('\n').length + foreign}: ${body[foreign].trim().slice(0, 60)}) — remove the block by hand, then run this again`);
    return dropBlock(text);
  }
  const where = marks.map(([i, m]) => `line ${text.slice(0, i).split('\n').length}: ${m}`).join('; ');
  throw new Error(`config.toml has marker lines left by an older slackline install that no longer form one block (${where}) — delete ${marks.length > 1 ? 'those lines' : 'that line'} by hand, then run this again`);
}

const HOOK_EVENTS = [['SessionStart', 'start'], ['SessionEnd', 'end']];
// A hook group is ours only when it is exactly the group we write. A group that holds our
// command beside someone else's is theirs and is never touched.
const ourGroup = (repo, verb) => ({ hooks: [{ type: 'command', command: `${shq(hookPath(repo))} ${verb} --agent codex` }] });
const hooksOf = (j) => {
  if (j.hooks !== undefined && !isObj(j.hooks)) throw new Error('Codex hooks.json has a "hooks" value that is not an object — not touching it');
  return j.hooks || {};
};
export function codexHooks(text, { repo }) {
  const j = parseJson(text, 'Codex hooks.json');
  const hooks = { ...hooksOf(j) };
  for (const [event, verb] of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`Codex hooks.json "hooks.${event}" is not a list — not touching it`);
    const groups = hooks[event] || [], mine = ourGroup(repo, verb);
    hooks[event] = groups.some(g => same(g, mine)) ? groups : [...groups, mine];
  }
  const next = { ...j, hooks };
  return same(next, j) ? text : dump(next);
}
export function unCodexHooks(text, { repo }) {
  if (!text.trim()) return text;
  const j = parseJson(text, 'Codex hooks.json');
  const hooks = { ...hooksOf(j) };
  let changed = false;
  for (const [event, verb] of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter(g => !same(g, ourGroup(repo, verb)));
    if (kept.length === hooks[event].length) continue;
    changed = true;
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (!changed) return text;
  const next = { ...j, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return dump(next);
}
const hasHooks = (text, repo) => {
  try { const h = hooksOf(JSON.parse(text)); return HOOK_EVENTS.every(([e, v]) => Array.isArray(h[e]) && h[e].some(g => same(g, ourGroup(repo, v)))); } catch { return false; }
};

export function bashrc(text, { repo }) {
  const f = shq(join(repo, 'agents', 'shell-init.sh'));
  return setBlock(text, `# slackline: the claude launcher and the Muse push switches (docs/agents.md)\n[ -r ${f} ] && . ${f}`);
}
export const unBashrc = (text) => dropBlock(text);

// A mode the operator wrote with quotes still counts.
const deliverMode = (text, name, dflt = 'native') => (text.match(new RegExp(`^${name}=["']?(native|tmux)["']?\\r?$`, 'm')) || [])[1] || dflt;

// Read by agents/hook.sh and the Muse plugin's hooks. SLACKLINE_DELIVER_* is the operator's to
// edit (native | tmux), so a re-run keeps whatever is there. The default differs by agent: Codex
// starts as native, Muse as tmux, because Muse 1.4.4 refuses a session message sent from a shell
// (`muse session-message send` answers unverified_target_receipt), so native delivery cannot work.
//
// Every other line the operator put in the file (SLACKLINE_HOOK_DEBUG=1, for one) is kept, in its
// original order, after the installer's own lines: for Muse this file is the only way a setting
// reaches a hook.
const ENV_HEADER = ['# Written by `slackline agents install`. Read by agents/hook.sh and the Muse plugin hooks.',
  '# SLACKLINE_DELIVER_<AGENT> is yours to edit: native | tmux (docs/agents.md).'];
const ENV_OWNED = /^(SLACKLINE_REPO|SLACKLINE_NODE|SLACKLINE_DELIVER_CODEX|SLACKLINE_DELIVER_MUSE)=/;
export function agentsEnv(text, { node, repo }) {
  const keep = (name, dflt) => deliverMode(text, name, dflt);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const extra = lines.filter(l => !ENV_OWNED.test(l) && !ENV_HEADER.includes(l.replace(/\r$/, '')));
  return [...ENV_HEADER,
    `SLACKLINE_REPO=${shq(repo)}`,
    `SLACKLINE_NODE=${shq(node)}`,
    `SLACKLINE_DELIVER_CODEX=${keep('SLACKLINE_DELIVER_CODEX')}`,
    `SLACKLINE_DELIVER_MUSE=${keep('SLACKLINE_DELIVER_MUSE', 'tmux')}`, ...extra, ''].join('\n');
}

// ---------- apply layer ----------

export const paths = (home) => ({
  dir: join(home, '.slackline'), config: join(home, '.slackline/config.json'), routes: join(home, '.slackline/routes.json'),
  agentsEnv: join(home, '.slackline/agents.env'), run: join(home, '.slackline/run'),
  bashrc: join(home, '.bashrc'), csl: join(home, '.local/bin/csl'), claudeJson: join(home, '.claude.json'),
  codexToml: join(home, '.codex/config.toml'), codexHooks: join(home, '.codex/hooks.json'),
  opencodeJson: join(home, '.config/opencode/opencode.json'), opencodePlugin: join(home, '.config/opencode/plugin/slackline.js'),
  museSettings: join(home, '.config/muse/settings.json'),
});

// Everything the apply layer touches, injectable so tests run against a fake HOME and
// recorded commands.
export function context({ home = homedir(), node = process.execPath, repo = REPO, runImpl = run, env = process.env,
  stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  return { home, node, repo, run: runImpl, env, stamp, p: paths(home),
    bin: { claude: env.CLAUDE_BIN || 'claude', codex: env.CODEX_BIN || 'codex', muse: env.MUSE_BIN || 'muse' } };
}

// Strict: only a missing file is "empty". Any other failure (a directory, no permission) fails
// the step, and so does a file that is not valid UTF-8 — rewriting it as text would corrupt it.
function read(file) {
  let buf;
  try { buf = readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${file} is not valid UTF-8 — not touching it`);
  return text;
}
const peek = (file) => { try { return read(file); } catch { return ''; } }; // for status: never throws
function backup(file, c) {
  const bak = `${file}.bak-slackline-${c.stamp}`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
}
// Compute one file's new text. A transform refuses by throwing, and nothing is written yet.
const plan = (file, fn, c) => { const before = read(file); return { file, before, after: fn(before, c) }; };
// Write a target's planned files, reporting each as it lands. Callers plan every file of a
// target first, so a refusal in any of them means none are written. The write goes straight
// through the path (no temp file and rename): a dotfile that is a symlink into a dotfiles repo
// must stay a symlink.
function commit(plans, c, say) {
  for (const { file, before, after } of plans) {
    if (after === before) { say(file, 'unchanged'); continue; }
    backup(file, c);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    say(file, before ? 'updated' : 'created');
  }
}
async function must(c, cmd, args, what) {
  const r = await c.run(cmd, args, { env: c.env });
  if (r.code !== 0) throw new Error(`${what} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
  return r;
}

const CSL = (c) => join(c.repo, 'scripts', 'csl');
const lstatOrNull = (f) => { try { return lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function checkCsl(c) {
  const st = lstatOrNull(c.p.csl);
  if (st && st.isSymbolicLink() && readlinkSync(c.p.csl) !== CSL(c)) throw new Error(`${c.p.csl} is a symlink to somewhere else — not replacing it`);
  if (st && !st.isSymbolicLink() && !st.isFile()) throw new Error(`${c.p.csl} is not a regular file or symlink — not replacing it`);
  return st;
}
function linkCsl(c) {
  const st = checkCsl(c);
  if (st && st.isSymbolicLink()) return 'unchanged';
  if (st) { backup(c.p.csl, c); rmSync(c.p.csl); }
  mkdirSync(dirname(c.p.csl), { recursive: true });
  symlinkSync(CSL(c), c.p.csl);
  return st ? 'updated' : 'created';
}
function unlinkCsl(c) {
  const st = lstatOrNull(c.p.csl);
  if (st && st.isSymbolicLink() && readlinkSync(c.p.csl) === CSL(c)) { rmSync(c.p.csl); return 'removed'; }
  return 'unchanged';
}

// Claude Code rewrites ~/.claude.json continuously, so we only ever READ it; changes go
// through `claude mcp add` / `claude mcp remove`.
const claudeEntry = (c) => { try { return JSON.parse(peek(c.p.claudeJson)).mcpServers?.slackline || null; } catch { return null; } };
const CLAUDE = 'Claude Code user-scope MCP server "slackline"';
const MUSE_PLUGIN = 'Muse plugin "slackline"';
// Codex rewrites ~/.codex/config.toml itself (and reformats it), so its registration is read
// and changed through its CLI only. As of Codex 0.160.1:
//   codex mcp list --json                    exit 0, a JSON array, one object per server:
//       { "name": "slackline", "enabled": true,
//         "transport": { "type": "stdio", "command": "<node>", "args": ["<repo>/mcp.mjs"],
//                        "env": { "SLACKLINE_REMOTE_ONLY": "1" } | null, "env_vars": [], "cwd": null }, … }
//   codex mcp add <name> --env K=V -- <command> <args…>      (--env repeats; stdio servers only)
//   codex mcp remove <name>
// One `list` is both the precondition (the codex command answers) and the current registration.
const CODEX = 'Codex MCP server "slackline"';
const codexList = async (c) => {
  const r = await c.run(c.bin.codex, ['mcp', 'list', '--json'], { env: c.env });
  if (r.code !== 0) return { ok: false, ran: false, why: firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}` };
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  if (!Array.isArray(j)) return { ok: false, ran: true, why: `${firstLine(r.stdout) || 'no output'}` };
  return { ok: true, entry: j.find(e => isObj(e) && e.name === 'slackline') || null };
};
// Two distinct failures: the command could not be run, or it ran and printed something else.
const codexWhy = (l) => (l.ran
  ? `the output of \`codex mcp list --json\` was not the expected JSON list (it began: ${l.why})`
  : `the codex command could not be run (${l.why})`);
// Codex rewrites config.toml when it adds or removes a server: back it up first (once per run).
const codexMcp = async (c, args, what) => { backup(c.p.codexToml, c); return must(c, c.bin.codex, args, what); };
const museList = async (c) => { const r = await c.run(c.bin.muse, ['plugins', 'list', '--json'], { env: c.env }); return { ok: r.code === 0, stdout: r.stdout, has: r.code === 0 && r.stdout.includes('"slackline"'), why: firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}` }; };
const OURS_PLUGIN = (c) => opencodePlugin(c);

const INSTALL = {
  // Always runs first: the hooks and the launcher read these two files.
  async common(c, say) {
    mkdirSync(c.p.dir, { recursive: true, mode: 0o700 });
    const plans = [plan(c.p.agentsEnv, agentsEnv, c)];
    if (existsSync(c.p.routes)) say(c.p.routes, 'unchanged'); else plans.push(plan(c.p.routes, () => '{\n  "defaults": [],\n  "routes": []\n}\n', c));
    commit(plans, c, say);
    // Readable by this user only, whatever the umask said or an older run left behind.
    try { if (existsSync(c.p.agentsEnv) && (lstatSync(c.p.agentsEnv).mode & 0o777) !== 0o600) chmodSync(c.p.agentsEnv, 0o600); } catch {}
  },
  // The csl link's refusal is checked before .bashrc is written: a refusal writes nothing.
  async shell(c, say) {
    const plans = [plan(c.p.bashrc, bashrc, c)];
    checkCsl(c);
    commit(plans, c, say);
    say(c.p.csl, linkCsl(c));
  },
  async claude(c, say) {
    const cur = claudeEntry(c);
    if (cur && !claudeOurs(cur, c.repo)) throw new Error('Claude Code already has a different user-scope "slackline" server — remove it with `claude mcp remove -s user slackline` first');
    const env = { SLACKLINE_CHANNEL: '1', SLACKLINE_ROUTES: '1', SLACKLINE_REMOTE_ONLY: '1' };
    if (cur && cur.command === c.node && same(cur.args, [mcpPath(c.repo)]) && same(cur.env || {}, env)) return say(CLAUDE, 'unchanged');
    if (cur) { await must(c, c.bin.claude, ['mcp', 'remove', '-s', 'user', 'slackline'], 'claude mcp remove'); say(`${CLAUDE} (replacing)`, 'removed'); }
    await must(c, c.bin.claude, ['mcp', 'add', '-s', 'user', 'slackline', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '--', c.node, mcpPath(c.repo)], 'claude mcp add');
    say(CLAUDE, cur ? 'updated' : 'created');
  },
  // Both files are planned before either is written: if the config is refused, the plugin
  // file is never written (no half-installed target).
  async opencode(c, say) {
    commit([plan(c.p.opencodeJson, opencodeJson, c),
      plan(c.p.opencodePlugin, (cur) => {
        if (!cur || cur === OURS_PLUGIN(c)) return OURS_PLUGIN(c);
        throw new Error(`${c.p.opencodePlugin} already exists with other content — not replacing it`);
      }, c)], c, say);
  },
  // Order matters: the external precondition and every refusal come before the first write.
  async codex(c, say) {
    const l = await codexList(c);
    if (!l.ok) throw new Error(codexWhy(l));
    const plans = [plan(c.p.codexToml, dropCodexBlock, c), plan(c.p.codexHooks, codexHooks, c)];
    // An old block IS the registration Codex just reported: once it is dropped there is none.
    const cur = plans[0].after !== plans[0].before ? null : l.entry;
    if (cur && !codexOurs(cur, c.repo)) throw new Error('Codex already has a different MCP server named "slackline" — remove it with `codex mcp remove slackline` first, or leave Codex\'s tools as they are');
    commit(plans, c, say);
    if (cur && cur.transport.command === c.node && same(cur.transport.env || {}, REMOTE_ONLY)) return say(CODEX, 'unchanged');
    if (cur) { await codexMcp(c, ['mcp', 'remove', 'slackline'], 'codex mcp remove'); say(`${CODEX} (replacing)`, 'removed'); }
    await codexMcp(c, ['mcp', 'add', 'slackline', ...Object.entries(REMOTE_ONLY).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      '--', c.node, mcpPath(c.repo)], 'codex mcp add');
    say(CODEX, cur ? 'updated' : 'created');
  },
  async muse(c, say) {
    // The external precondition runs before any file is touched.
    const l = await museList(c);
    if (!l.ok) throw new Error(`the muse command is not available (${l.why})`);
    commit([plan(c.p.museSettings, museSettings, c)], c, say);
    if (l.has) await must(c, c.bin.muse, ['plugins', 'update', 'slackline', '--json'], 'muse plugins update');
    else await must(c, c.bin.muse, ['plugins', 'install', join(c.repo, 'agents', 'muse', 'plugin'), '--scope', 'user', '--json'], 'muse plugins install');
    say(MUSE_PLUGIN, l.has ? 'updated' : 'created');
    await must(c, c.bin.muse, ['plugins', 'approve', 'slackline', '--json'], 'muse plugins approve');
    // A re-install after an uninstall (which disables) must turn the plugin back on.
    await must(c, c.bin.muse, ['plugins', 'enable', 'slackline', '--json'], 'muse plugins enable');
  },
};

const UNINSTALL = {
  async shell(c, say) { commit([plan(c.p.bashrc, unBashrc, c)], c, say); say(c.p.csl, unlinkCsl(c)); },
  async claude(c, say) {
    if (!claudeOurs(claudeEntry(c), c.repo)) return say(CLAUDE, 'unchanged');
    await must(c, c.bin.claude, ['mcp', 'remove', '-s', 'user', 'slackline'], 'claude mcp remove');
    say(CLAUDE, 'removed');
  },
  async opencode(c, say) {
    const p = plan(c.p.opencodeJson, unOpencodeJson, c);
    const ours = read(c.p.opencodePlugin) === OURS_PLUGIN(c);
    commit([p], c, say);
    if (ours) rmSync(c.p.opencodePlugin);
    say(c.p.opencodePlugin, ours ? 'removed' : 'unchanged');
  },
  // Read what Codex reports first: if that cannot be read, nothing is touched (the registration,
  // if any, stays). Then the files (an old block, our hook groups), then the registration:
  // removed only when it is ours. An old block IS the registration Codex reported.
  async codex(c, say) {
    const l = await codexList(c);
    if (!l.ok) throw new Error(`${codexWhy(l)}; no file was changed and the "slackline" registration, if any, was left in place`);
    const plans = [plan(c.p.codexToml, dropCodexBlock, c), plan(c.p.codexHooks, unCodexHooks, c)];
    const cur = plans[0].after !== plans[0].before ? null : l.entry;
    commit(plans, c, say);
    if (!codexOurs(cur, c.repo)) return say(CODEX, 'unchanged');
    await codexMcp(c, ['mcp', 'remove', 'slackline'], 'codex mcp remove');
    say(CODEX, 'removed');
  },
  // Muse has no `plugins uninstall`; disabling is the documented way to turn a plugin off.
  // Read what Muse reports first, as for Codex: if that cannot be read nothing is touched. A
  // failed disable fails the target too: "unchanged" would tell the operator the plugin is off
  // when it is still running its hooks.
  async muse(c, say) {
    const l = await museList(c);
    if (!l.ok) throw new Error(`the muse command could not be run (${l.why}); no file was changed and the "slackline" plugin, if any, was left in place`);
    let listed = null;
    try { listed = JSON.parse(l.stdout); } catch {}
    if (listed === null) throw new Error(`the output of \`muse plugins list --json\` was not the expected JSON (it began: ${firstLine(l.stdout) || 'no output'}); no file was changed and the "slackline" plugin, if any, was left in place`);
    commit([plan(c.p.museSettings, unMuseSettings, c)], c, say);
    if (!l.has) return say(MUSE_PLUGIN, 'unchanged');
    await must(c, c.bin.muse, ['plugins', 'disable', 'slackline', '--json'], 'muse plugins disable');
    say(MUSE_PLUGIN, 'disabled');
  },
};

// The listeners in the run directory, read from the files alone (no external command).
const scanListeners = (c) => !existsSync(c.p.run) ? [] : readdirSync(c.p.run).filter(f => f.endsWith('.pid')).map(f => {
  const pid = Number(peek(join(c.p.run, f))) || 0;
  return { name: f.slice(0, -4), pid, alive: !!pid && alive(pid) };
});

// What is wired right now, as data (status() below formats it).
export async function inspect(c) {
  const json = (f) => { try { return JSON.parse(peek(f)) || {}; } catch { return {}; } };
  const env = peek(c.p.agentsEnv);
  const shellInit = peek(c.p.bashrc).includes(shq(join(c.repo, 'agents', 'shell-init.sh')));
  const listeners = scanListeners(c);
  const codexEntry = (await codexList(c)).entry;
  const claudeE = json(c.p.claudeJson).mcpServers?.slackline, ocE = json(c.p.opencodeJson).mcp?.slackline, museE = json(c.p.museSettings).mcpServers?.slackline;
  // A "slackline" registration that is not this checkout's (the checkout moved, or someone
  // else wrote it): not "NO tools", which would suggest nothing is registered.
  const others = [['claude', claudeE, claudeOurs], ['opencode', ocE, ocOurs], ['codex', codexEntry, codexOurs], ['muse', museE, museOurs]]
    .filter(([, e, ours]) => e && !ours(e, c.repo)).map(([a]) => a);
  return {
    others,
    claude: { tools: claudeOurs(claudeE, c.repo), push: shellInit },
    opencode: { tools: ocOurs(ocE, c.repo), push: peek(c.p.opencodePlugin) === OURS_PLUGIN(c) },
    codex: { tools: codexOurs(codexEntry, c.repo), push: hasHooks(peek(c.p.codexHooks), c.repo), deliver: deliverMode(env, 'SLACKLINE_DELIVER_CODEX') },
    muse: { tools: museOurs(museE, c.repo), push: (await museList(c)).has, deliver: deliverMode(env, 'SLACKLINE_DELIVER_MUSE', 'tmux') },
    shell: { init: shellInit, env: !!env },
    listeners,
  };
}

export async function status(c, cwd = process.cwd()) {
  const lines = [];
  const cfg = remoteConfig(c.env, { configPath: c.p.config });
  if (!cfg) lines.push('hub        NOT CONFIGURED — create ~/.slackline/config.json (docs/agents.md)');
  else {
    // /health needs a valid key, so this checks the key as well as the hub. The error text
    // names the URL and the hub's reply, never the key.
    try {
      const w = await whoami(cfg), live = (w.match(/orgs_live: (.*)$/) || [])[1];
      lines.push(`hub        ok — ${cfg.url}, workspaces: ${live || '?'}`);
      // The hub answered, so a workspace named in routes.json that it does not serve is a typo
      // (or a key without that scope): every stream for it would be refused.
      if (live) {
        const served = live === '(none)' ? [] : live.split(', ');
        const { defaults, routes } = loadRoutes(c.env.SLACKLINE_ROUTES_FILE || c.p.routes);
        for (const org of new Set([...defaults, ...routes].map(e => e.org))) {
          if (!served.includes(org)) lines.push(`route      WARNING — routes.json names workspace "${org}", which the hub does not serve`);
        }
      }
    } catch (e) { lines.push(`hub        FAILED — ${e.message}`); }
  }
  const streams = resolveRoute(cwd, { file: c.env.SLACKLINE_ROUTES_FILE || c.p.routes });
  lines.push(`route      ${cwd} -> ${streams.length ? streams.map(s => `${s.org}: ${s.channels.join(', ')}`).join('; ') : '(nothing routed: tools only)'}`);
  const s = await inspect(c), yn = (b) => (b ? 'yes' : 'NO');
  for (const a of ['claude', 'opencode', 'codex', 'muse']) {
    // Only the agents with a listener process get a live count.
    const live = s[a].deliver ? `  listeners: ${s.listeners.filter(l => l.alive && l.name.startsWith(`${a}-`)).length}` : '';
    lines.push(`${a.padEnd(10)} tools: ${s[a].tools ? 'yes' : s.others.includes(a) ? 'OTHER' : 'NO'}  push: ${yn(s[a].push)}${s[a].deliver ? `  deliver: ${s[a].deliver}` : ''}${live}`);
  }
  lines.push(`shell      init in ~/.bashrc: ${yn(s.shell.init)}  agents.env: ${yn(s.shell.env)}`);
  lines.push(s.listeners.length
    ? `listeners  ${s.listeners.map(l => `${l.name} (pid ${l.pid}${l.alive ? '' : ', DEAD — stale pid file'})`).join(', ')}`
    : 'listeners  none running');
  if (s.others.length) lines.push(`note       a "slackline" entry that is not this checkout's exists for: ${s.others.join(', ')} — if the checkout was moved, uninstall from the old path or remove it by hand`);
  return lines.join('\n');
}

export async function main(args, c = context()) {
  const [verb, ...names] = args;
  const targets = names.length ? names : TARGETS;
  if (!['install', 'status', 'uninstall'].includes(verb) || targets.some(t => !TARGETS.includes(t))) {
    console.error(`usage: slackline agents <install|status|uninstall> [${TARGETS.join('|')} …]`);
    return 1;
  }
  if (verb === 'status') { console.log(await status(c)); return 0; }
  const steps = verb === 'install' ? INSTALL : UNINSTALL;
  const say = (what, result) => console.log(`${result.padEnd(9)} ${what}`);
  let failed = 0;
  for (const t of verb === 'install' ? ['common', ...targets] : targets) {
    try { await steps[t](c, say); }
    catch (e) { failed++; console.error(`FAILED    ${t}: ${e.message}`); }
  }
  if (verb === 'uninstall') {
    // A running listener belongs to a live session, so it is named, not killed.
    const live = scanListeners(c).filter(l => l.alive);
    if (live.length) console.log(`note      ${live.length} listener${live.length > 1 ? 's' : ''} still running: ${live.map(l => `${l.name} (pid ${l.pid})`).join(', ')} — each ends with its session; to stop now: kill ${live.map(l => l.pid).join(' ')}`);
  }
  return failed ? 1 : 0;
}
