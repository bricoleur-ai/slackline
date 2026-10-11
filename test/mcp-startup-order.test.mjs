// mcp.mjs must register its request handlers BEFORE the stdio transport goes live.
//
// Regression test for a real failure: Claude Code reported
//   "MCP server slackline: Failed to fetch tools: Method not found"
// while reporting the connection itself as successful. It looked like the experimental
// claude/channel capability declaration or the negotiated protocol era was at fault. It was
// neither — the transport was answering requests while ListToolsRequestSchema had no handler
// yet, and the SDK correctly returns -32601 for that. Push mode gated both the capability AND
// an `await tail.connect()` between the two, so an A/B on push implicated the wrong one.
//
// The hub delay below is what makes this deterministic: a real hub is a network round trip
// away, so the window is wide open in a real deployment and invisible on a fast local loopback.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function slowHub(delayMs) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('\n');                                    // established, then held open
      }, delayMs);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// Drives a real mcp.mjs over stdio: initialize, then tools/list, exactly as a client does.
function listTools(env) {
  return new Promise((resolve, reject) => {
    // An empty HOME keeps the developer's real ~/.slackline/config.json out of the child.
    const child = spawn(process.execPath, ['mcp.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'slk-startup-')), SLACKLINE_STORE: 'memory', ...env } });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 20000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) {
          clearTimeout(timer); child.kill();
          resolve(m.error ? { error: m.error } : { tools: m.result.tools.length });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  });
}

test('tools/list answers even when push mode awaits a slow hub at startup', async () => {
  const { srv, port } = await slowHub(1500);
  try {
    const res = await listTools({ SLACKLINE_REMOTE: `http://127.0.0.1:${port}`,
      SLACKLINE_SECRET: 'x', SLACKLINE_CHANNEL: '1' });
    assert.equal(res.error, undefined,
      `tools/list must not fail while startup work is pending, got ${JSON.stringify(res.error)}`);
    assert.ok(res.tools > 0, 'expected a non-empty tool list');
  } finally { srv.close(); }
});

test('the experimental claude/channel capability alone does not break tools/list', async () => {
  const res = await listTools({ SLACKLINE_CHANNEL: '1', SLACKLINE_XOXC: 'xoxc-fake', SLACKLINE_XOXD: 'fake' });
  assert.equal(res.error, undefined);
  assert.ok(res.tools > 0);
});
