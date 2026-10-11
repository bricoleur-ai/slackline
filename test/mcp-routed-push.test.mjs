// End-to-end proof of routed push: spawns the real `node mcp.mjs`
// against a fake two-workspace hub and checks what a code read cannot — that SLACKLINE_ROUTES=1
// opens one /tail per workspace for this directory's channels, that each pushed message says
// which workspace it came from, and that a reply goes back to that workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP = fileURLToPath(new URL('../mcp.mjs', import.meta.url));
const ROWS = {
  orgA: { channel: 'CA', channel_name: '#alpha', ts: '1700000001.000100', user: 'U1', user_name: 'Ann', text: 'from A', origin: 'human' },
  orgB: { channel: 'CB', channel_name: '#beta', ts: '1700000002.000200', user: 'U2', user_name: 'Bob', text: 'from B', origin: 'human' },
};

function startFakeHub({ refuse = [] } = {}) {
  const tails = [], says = [], open = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/tail') {
      const org = url.searchParams.get('org');
      if (refuse.includes(org)) return json(403, { error: `key does not cover ${org}` });
      tails.push({ org, channels: url.searchParams.get('channels'), origin: url.searchParams.get('origin') });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders();
      open.push(res);
      if (ROWS[org]) setTimeout(() => res.write(JSON.stringify(ROWS[org]) + '\n'), 50);
      return;                                       // held open, like the real stream
    }
    if (url.pathname === '/say' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => body += c);
      return req.on('end', () => { says.push(JSON.parse(body || '{}')); json(200, { ok: true, ts: '1700000009.000900' }); });
    }
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1',
    () => resolve({ server, tails, says, open, url: `http://127.0.0.1:${server.address().port}` })));
}

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
}

// Starts mcp.mjs in <home>/<cwdName> with a routes file built from that home.
async function launch(t, { cwdName, routes, refuse, extraEnv = {} }) {
  const hub = await startFakeHub({ refuse });
  const home = mkdtempSync(path.join(tmpdir(), 'slk-mcp-routes-'));
  for (const d of ['mapped', 'unmapped']) mkdirSync(path.join(home, d));
  const file = path.join(home, 'routes.json');
  writeFileSync(file, JSON.stringify(routes(home)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], cwd: path.join(home, cwdName), stderr: 'pipe',
    env: { HOME: home, SLACKLINE_REMOTE: hub.url, SLACKLINE_SECRET: 's', SLACKLINE_ORG: 'orgA',
      SLACKLINE_CHANNEL: '1', SLACKLINE_ROUTES: '1', SLACKLINE_ROUTES_FILE: file, ...extraEnv } });
  const out = { stderr: '', pushed: [] };
  transport.stderr?.on('data', (c) => { out.stderr += c; });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') out.pushed.push(n.params); };
  t.after(async () => {
    await client.close().catch(() => {});
    for (const r of hub.open) r.destroy();
    await new Promise((r) => hub.server.close(r));
    rmSync(home, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { hub, client, out };
}

const routes = (home) => ({
  defaults: [{ org: 'orgA', channels: ['CA'] }],
  routes: [{ dir: path.join(home, 'mapped'), org: 'orgB', channels: ['CB'] }] });

test('SLACKLINE_ROUTES=1 opens one stream per workspace and tags each pushed message with its workspace', async (t) => {
  const { hub, client, out } = await launch(t, { cwdName: 'mapped', routes });
  assert.ok(await until(() => out.pushed.length === 2), `expected two pushes, got ${out.pushed.length}; stderr: ${out.stderr}`);
  assert.deepEqual(hub.tails.map(x => `${x.org}:${x.channels}`).sort(), ['orgA:CA', 'orgB:CB']);
  for (const x of hub.tails) assert.equal(x.origin, 'human,peer', 'the hub is still asked to drop our own posts');
  const byOrg = Object.fromEntries(out.pushed.map(p => [p.meta.org, p]));
  assert.equal(byOrg.orgA.content, 'Ann: from A');
  assert.equal(byOrg.orgB.content, 'Bob: from B');
  assert.equal(byOrg.orgB.meta.channel, 'CB');

  // A reply goes to the workspace the channel belongs to; an unknown channel uses the default.
  await client.callTool({ name: 'slack_say', arguments: { channel: 'CB', text: 'ack', thread_ts: ROWS.orgB.ts } });
  await client.callTool({ name: 'slack_say', arguments: { channel: 'CZ', text: 'hello' } });
  assert.deepEqual(hub.says.map(s => `${s.channel}@${s.org}`), ['CB@orgB', 'CZ@orgA']);
});

test('a directory with nothing routed opens no stream and still serves tools', async (t) => {
  const { hub, client, out } = await launch(t, { cwdName: 'unmapped',
    routes: (home) => ({ defaults: [], routes: [{ dir: path.join(home, 'mapped'), org: 'orgB', channels: ['CB'] }] }) });
  const { tools } = await client.listTools();
  assert.ok(tools.some(x => x.name === 'slack_say'));
  assert.ok(await until(() => /mcp server ready/.test(out.stderr)), out.stderr);
  assert.equal(hub.tails.length, 0, 'no channels means no hub stream at all, not an all-channels stream');
  assert.match(out.stderr, /no channels routed/);
});

test('SLACKLINE_REMOTE_ONLY=1 with no hub configured exits instead of becoming a local-mode server', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const home = mkdtempSync(path.join(tmpdir(), 'slk-mcp-remote-only-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [MCP], { cwd: home, encoding: 'utf8', timeout: 15000, input: '',
    env: { PATH: process.env.PATH, HOME: home, SLACKLINE_REMOTE_ONLY: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLACKLINE_REMOTE_ONLY/);
  assert.deepEqual(readdirSync(home), [], 'no slackline.db, no blobs, no ~/.slackline — nothing was created');
});

test('a refused workspace does not take the tools down: the server stays up and the good stream pushes', async (t) => {
  const { hub, client, out } = await launch(t, { cwdName: 'mapped', refuse: ['orgB'], routes });
  assert.ok(await until(() => out.pushed.length === 1), `expected the good workspace's push; stderr: ${out.stderr}`);
  assert.equal(out.pushed[0].meta.org, 'orgA');
  assert.ok(await until(() => /refused the stream for workspace "orgB"/.test(out.stderr)), out.stderr);
  const { tools } = await client.listTools();
  assert.ok(tools.some(x => x.name === 'slack_say'));
  await client.callTool({ name: 'slack_say', arguments: { channel: 'CA', text: 'still here' } });
  assert.deepEqual(hub.says.map(s => `${s.channel}@${s.org}`), ['CA@orgA']);
  assert.doesNotMatch(out.stderr, /FATAL/);
});

test('legacy SLACKLINE_CHANNEL_ONLY against a hub that answers 403 still exits non-zero', async (t) => {
  const hub = await startFakeHub({ refuse: ['orgA'] });
  const home = mkdtempSync(path.join(tmpdir(), 'slk-mcp-legacy-'));
  t.after(async () => { await new Promise((r) => hub.server.close(r)); rmSync(home, { recursive: true, force: true }); });
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [MCP], { cwd: home, env: { PATH: process.env.PATH, HOME: home, SLACKLINE_REMOTE: hub.url, SLACKLINE_SECRET: 's', SLACKLINE_ORG: 'orgA', SLACKLINE_CHANNEL: '1', SLACKLINE_CHANNEL_ONLY: 'CA' } });
    let stderr = ''; c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (code) => resolve({ code, stderr }));
    setTimeout(() => c.kill(), 10000).unref();   // a watchdog, not a reason to keep node alive
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /FATAL/);
});

test('with SLACKLINE_CHANNEL_ONLY set a routes file naming the channel for another workspace is ignored', async (t) => {
  const { hub, client } = await launch(t, { cwdName: 'mapped', routes, extraEnv: { SLACKLINE_CHANNEL_ONLY: 'CZ' } });
  await client.callTool({ name: 'slack_say', arguments: { channel: 'CB', text: 'hello' } });
  assert.deepEqual(hub.says.map(s => `${s.channel}@${s.org}`), ['CB@orgA'], 'the configured workspace, not the table\'s orgB');
});

test('mcp.mjs exits when its stdin ends, even with a push stream open', async (t) => {
  const hub = await startFakeHub();
  const home = mkdtempSync(path.join(tmpdir(), 'slk-mcp-eof-'));
  t.after(async () => { for (const r of hub.open) r.destroy(); await new Promise((r) => hub.server.close(r)); rmSync(home, { recursive: true, force: true }); });
  const c = spawn(process.execPath, [MCP], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, SLACKLINE_REMOTE: hub.url, SLACKLINE_SECRET: 's', SLACKLINE_ORG: 'orgA', SLACKLINE_CHANNEL: '1' } });
  t.after(() => c.kill());
  const exited = new Promise((resolve) => c.on('exit', (code) => resolve(code)));
  assert.ok(await until(() => hub.tails.length === 1), 'the push stream is open');
  c.stdin.end();
  // Cleared after the race so the loser does not hold the event loop open for 5s once the
  // process has already exited.
  let late;
  const code = await Promise.race([exited, new Promise((r) => { late = setTimeout(() => r('still running'), 5000); })]);
  clearTimeout(late);
  assert.equal(code, 0);
});
