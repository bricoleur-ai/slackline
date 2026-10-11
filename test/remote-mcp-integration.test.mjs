// End-to-end proof that SLACKLINE_REMOTE actually flips mcp.mjs into a thin proxy: spawns the
// real `node mcp.mjs` as a child process (real stdio MCP handshake, real remote.mjs code path)
// against a small in-process fake hub (node:http) standing in for api.mjs — never the real
// slackline hub. Confirms three things a code read can't: (1) the tool list over the wire is
// byte-for-byte the same shape as local mode's, minus the two hub-only app-credential tools;
// (2) a proxied call and a failed one both round-trip correctly, including isError; (3) remote
// mode genuinely never touches the store — no sqlite file, no ./blobs dir — the whole reason
// this feature exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP = fileURLToPath(new URL('../mcp.mjs', import.meta.url));
const SECRET = 'integration-test-secret';

// Minimal stand-in for api.mjs: just enough of the contract remote.mjs actually calls.
function startFakeHub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, secret: req.headers['x-slackline-secret'] });
    if (req.headers['x-slackline-secret'] !== SECRET) {
      res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/health') return json(200, { ok: true, orgs_live: ['testorg'] });
    if (url.pathname === '/recent') {
      assert.equal(url.searchParams.get('org'), 'testorg');
      assert.equal(url.searchParams.get('channel'), 'C1');
      return json(200, { org: 'testorg', channel: '#general', transcript: '[10:00] alice: hi', messages: [] });
    }
    if (url.pathname === '/say' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => body += c); return req.on('end', () => {
        const b = JSON.parse(body || '{}');
        if (b.channel === 'CBAD') return json(400, { error: 'channel_not_found' });
        return json(200, { ok: true, ts: '1700000000.000100', channel: b.channel });
      });
    }
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('mcp.mjs in remote mode: tool schemas match local mode, proxies read/write, surfaces hub errors, and never creates a store', async (t) => {
  const { server: hub, seen, url } = await startFakeHub();
  const dir = mkdtempSync(path.join(tmpdir(), 'slackline-remote-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    cwd: dir,
    stderr: 'pipe',
    // HOME is the empty temp dir so the developer's real ~/.slackline/config.json (whose `key`
    // would outrank SLACKLINE_SECRET and get a 401 from the fake hub) cannot leak in.
    env: { HOME: dir, SLACKLINE_REMOTE: url, SLACKLINE_SECRET: SECRET, SLACKLINE_ORG: 'testorg' },
  });
  let stderr = '';
  transport.stderr?.on('data', (c) => { stderr += c; });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });

  t.after(async () => {
    await client.close().catch(() => {});
    await new Promise((r) => hub.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['slack_context', 'slack_history', 'slack_react', 'slack_recent', 'slack_say', 'slack_search', 'slack_thread', 'slack_whoami'].sort());
  // app-credential provisioning has no hub HTTP equivalent — must not be offered remotely
  assert.ok(!names.includes('slack_app_status'));
  assert.ok(!names.includes('slack_app_link'));

  // Same input schema as local mode (README/local TOOLS array) for every proxied tool.
  const recent = tools.find((t) => t.name === 'slack_recent');
  assert.deepEqual(recent.inputSchema, { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] });
  const say = tools.find((t) => t.name === 'slack_say');
  assert.deepEqual(say.inputSchema, { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, thread_ts: { type: 'string' }, no_badge: { type: 'boolean' } }, required: ['channel', 'text'] });

  // Read proxy round-trips the hub's transcript.
  const r1 = await client.callTool({ name: 'slack_recent', arguments: { channel: 'C1' } });
  assert.equal(r1.isError, undefined);
  assert.equal(r1.content[0].text, '[10:00] alice: hi');

  // Write proxy: success path carries the posted ts through.
  const r2 = await client.callTool({ name: 'slack_say', arguments: { channel: 'C1', text: 'hi there' } });
  assert.match(r2.content[0].text, /^posted ts=1700000000\.000100$/);

  // Write proxy: hub failure surfaces loudly as an MCP tool error, never an empty success.
  const r3 = await client.callTool({ name: 'slack_say', arguments: { channel: 'CBAD', text: 'hi' } });
  assert.equal(r3.isError, true);
  assert.match(r3.content[0].text, /400/);
  assert.match(r3.content[0].text, /channel_not_found/);

  // whoami reports the hub, not a Slack identity this process doesn't have.
  const r4 = await client.callTool({ name: 'slack_whoami', arguments: {} });
  assert.match(r4.content[0].text, /hub's/);
  assert.match(r4.content[0].text, /testorg/);

  // Every authenticated request carried the secret as a header, never a query string.
  assert.ok(seen.length > 0);
  for (const s of seen) if (s.path !== '/health' || s.secret !== undefined) assert.equal(s.secret, SECRET);

  // The whole point: remote mode never created a store or blob dir in the process cwd.
  const entries = readdirSync(dir);
  assert.ok(!entries.includes('slackline.db'), `unexpected store file(s): ${entries}`);
  assert.ok(!entries.includes('blobs'), `unexpected blob dir: ${entries}`);

  // Startup log names the mode/hub, never the secret; local-mode's "no credentials" warning
  // (which would mean it fell back to local mode instead of proxying) must not appear.
  assert.match(stderr, /remote mode: proxying to/);
  assert.ok(!stderr.includes(SECRET));
  assert.ok(!stderr.includes('no credentials'));
});
