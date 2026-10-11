// agents/route.mjs decides which Slack channels a session in a given directory listens to.
// Every adapter (Claude Code's MCP server, the OpenCode plugin, the Codex/Muse listener) asks
// it the same question, so a wrong answer here is wrong everywhere at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRoutes, resolve, orgForChannel, pushPlan, sessionDir } from '../agents/route.mjs';

const ROUTE = fileURLToPath(new URL('../agents/route.mjs', import.meta.url));

// A scratch tree (<root>/proj/app/src, <root>/proj/appendix, <root>/other) plus a routes file
// built from the root, so entries can name real absolute paths.
function tree(t, build) {
  const root = mkdtempSync(join(tmpdir(), 'slk-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ['proj/app/src', 'proj/appendix', 'other']) mkdirSync(join(root, d), { recursive: true });
  const file = join(root, 'routes.json');
  writeFileSync(file, typeof build === 'string' ? build : JSON.stringify(build(root)));
  return { root, file };
}
const sorted = (streams) => streams.map(s => ({ org: s.org, channels: [...s.channels].sort() }))
  .sort((a, b) => a.org.localeCompare(b.org));

test('an unmapped directory gets the defaults and nothing else', (t) => {
  const { root, file } = tree(t, (r) => ({
    defaults: [{ org: 'acme', channels: ['D1'] }],
    routes: [{ dir: join(r, 'proj'), org: 'acme', channels: ['C1'] }] }));
  assert.deepEqual(resolve(join(root, 'other'), { file }), [{ org: 'acme', channels: ['D1'] }]);
});

test('the nearest mapped ancestor wins; a farther one is not added', (t) => {
  const { root, file } = tree(t, (r) => ({
    defaults: [],
    routes: [{ dir: join(r, 'proj'), org: 'acme', channels: ['CFAR'] },
             { dir: join(r, 'proj/app'), org: 'acme', channels: ['CNEAR'] }] }));
  assert.deepEqual(resolve(join(root, 'proj/app/src'), { file }), [{ org: 'acme', channels: ['CNEAR'] }]);
  assert.deepEqual(resolve(join(root, 'proj/app'), { file }), [{ org: 'acme', channels: ['CNEAR'] }]);
  assert.deepEqual(resolve(join(root, 'proj'), { file }), [{ org: 'acme', channels: ['CFAR'] }]);
});

test('a sibling that merely shares a name prefix does not match', (t) => {
  const { root, file } = tree(t, (r) => ({ defaults: [], routes: [{ dir: join(r, 'proj/app'), org: 'acme', channels: ['C1'] }] }));
  assert.deepEqual(resolve(join(root, 'proj/appendix'), { file }), []);
});

test('one directory can listen in two workspaces; channels merge and dedupe per workspace', (t) => {
  const { root, file } = tree(t, (r) => ({
    defaults: [{ org: 'acme', channels: ['D1', 'C1'] }],
    routes: [{ dir: join(r, 'proj'), org: 'acme', channels: ['C1', 'C2'] },
             { dir: join(r, 'proj'), org: 'Globex Corp', channels: ['C9'] }] }));
  assert.deepEqual(sorted(resolve(join(root, 'proj'), { file })),
    [{ org: 'acme', channels: ['C1', 'C2', 'D1'] }, { org: 'Globex Corp', channels: ['C9'] }]);
});

test('a trailing slash on a route dir and a symlinked session directory both still match', (t) => {
  const { root, file } = tree(t, (r) => ({ defaults: [], routes: [{ dir: join(r, 'proj/app') + '/', org: 'acme', channels: ['C1'] }] }));
  symlinkSync(join(root, 'proj/app/src'), join(root, 'link'));
  assert.deepEqual(resolve(join(root, 'link'), { file }), [{ org: 'acme', channels: ['C1'] }]);
});

test('a missing, malformed or wrongly shaped file is "no routes", never an error', (t) => {
  const { root } = tree(t, '{ not json');
  assert.deepEqual(resolve(root, { file: join(root, 'routes.json') }), []);
  assert.deepEqual(resolve(root, { file: join(root, 'absent.json') }), []);
  const bad = join(root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ defaults: 'nope', routes: [{ dir: 'relative/path', org: 'acme', channels: ['C1'] },
    { dir: root, channels: ['C2'] }, { dir: root, org: 'acme', channels: 'C3' }, null] }));
  assert.deepEqual(loadRoutes(bad), { defaults: [], routes: [] });
});

test('orgForChannel finds a channel in any entry, not only the current directory', (t) => {
  const { root, file } = tree(t, (r) => ({
    defaults: [{ org: 'acme', channels: ['D1'] }],
    routes: [{ dir: join(r, 'proj'), org: 'Globex Corp', channels: ['C9'] }] }));
  assert.equal(orgForChannel('C9', { file }), 'Globex Corp');
  assert.equal(orgForChannel('D1', { file }), 'acme');
  assert.equal(orgForChannel('CNOPE', { file }), null);
  assert.ok(root);
});

test('pushPlan: explicit channel list wins, then routing, then everything', (t) => {
  const { root, file } = tree(t, (r) => ({ defaults: [], routes: [{ dir: join(r, 'proj'), org: 'acme', channels: ['C1'] }] }));
  const proj = join(root, 'proj'), other = join(root, 'other');
  assert.deepEqual(pushPlan({ SLACKLINE_CHANNEL_ONLY: 'CX, CY', SLACKLINE_ROUTES: '1' }, proj, { file, defaultOrg: 'dflt' }),
    [{ org: 'dflt', channels: ['CX', 'CY'] }], 'an explicit list must behave exactly as before');
  assert.deepEqual(pushPlan({ SLACKLINE_ROUTES: '1' }, proj, { file, defaultOrg: 'dflt' }), [{ org: 'acme', channels: ['C1'] }]);
  assert.deepEqual(pushPlan({ SLACKLINE_ROUTES: '1' }, other, { file, defaultOrg: 'dflt' }), [], 'nothing routed means no stream');
  assert.deepEqual(pushPlan({}, proj, { file, defaultOrg: 'dflt' }), [{ org: 'dflt', channels: [] }], 'unset/unset keeps today\'s all-channels behaviour');
});

test('sessionDir prefers SLACKLINE_SESSION_DIR over the process cwd', () => {
  assert.equal(sessionDir({ SLACKLINE_SESSION_DIR: '/x/y' }), '/x/y');
  assert.equal(sessionDir({}), process.cwd());
});

test('as a script: prints the resolution; --quiet prints nothing and exits 1 when nothing resolves', (t) => {
  const { root, file } = tree(t, (r) => ({ defaults: [], routes: [{ dir: join(r, 'proj'), org: 'acme', channels: ['C1'] }] }));
  const run = (...args) => spawnSync(process.execPath, [ROUTE, ...args], { encoding: 'utf8', env: { ...process.env, SLACKLINE_ROUTES_FILE: file } });
  const hit = run(join(root, 'proj'));
  assert.equal(hit.status, 0);
  assert.deepEqual(JSON.parse(hit.stdout).streams, [{ org: 'acme', channels: ['C1'] }]);
  const miss = run(join(root, 'other'));
  assert.equal(miss.status, 0, 'a plain lookup of an unrouted directory is an answer, not a failure');
  assert.deepEqual(JSON.parse(miss.stdout).streams, []);
  assert.equal(run('--quiet', join(root, 'proj')).status, 0);
  const q = run('--quiet', join(root, 'other'));
  assert.equal(q.status, 1);
  assert.equal(q.stdout, '');
});
