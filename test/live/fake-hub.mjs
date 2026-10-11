#!/usr/bin/env node
// A stand-in slackline hub for LIVE adapter checks: prove that a message reaches a real agent
// session end to end without Slack, the real hub, or a second person to post it.
//
//   node test/live/fake-hub.mjs [--port 8799]          (0 picks a free port)
//   curl -s localhost:8799/subscribers
//   curl -s -XPOST localhost:8799/emit -d '{"org":"testorg","channel":"CTEST","text":"Reply with the single word PONG"}'
//
// Point an agent at it with SLACKLINE_REMOTE=http://127.0.0.1:8799 and a routes file that maps
// its directory to the same org and channel (docs/agents.md, "Checking push without Slack").
// It serves only what the adapters use: /health, /tail, /say, /react. It checks no credentials
// and keeps nothing; never expose it beyond loopback.
import http from 'node:http';

const arg = process.argv.indexOf('--port');
const port = arg >= 0 && process.argv[arg + 1] !== undefined ? Number(process.argv[arg + 1]) : 8799;
const subs = new Set();
let n = 0;
const now = () => Math.floor(Date.now() / 1000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj) + '\n'); };
  const body = () => new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });

  if (url.pathname === '/health') return json(200, { ok: true, orgs_live: ['testorg'] });

  if (url.pathname === '/tail') {
    const sub = { org: url.searchParams.get('org') || 'testorg', channels: (url.searchParams.get('channels') || '').split(',').filter(Boolean), res };
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
    res.flushHeaders();
    subs.add(sub);
    req.on('close', () => { subs.delete(sub); console.log(`- tail org=${sub.org} channels=${sub.channels.join(',') || '(all)'} (${subs.size} open)`); });
    console.log(`+ tail org=${sub.org} channels=${sub.channels.join(',') || '(all)'} (${subs.size} open)`);
    return;                                                     // held open, like the real stream
  }

  if (url.pathname === '/subscribers') return json(200, [...subs].map(s => ({ org: s.org, channels: s.channels })));

  if (url.pathname === '/emit' && req.method === 'POST') return body().then((b) => {
    const ts = `${now()}.${String(++n).padStart(6, '0')}`;
    const row = { channel: b.channel || 'CTEST', channel_name: '#' + (b.channel_name || 'slackline-test'), ts, thread_ts: ts,
      user: 'UTEST', user_name: b.user_name || 'Fake Hub', origin: b.origin || 'human', text: b.text || 'ping', has_files: false, files: [] };
    let sent = 0;
    for (const s of subs) {
      if (s.org !== (b.org || 'testorg')) continue;
      if (s.channels.length && !s.channels.includes(row.channel)) continue;
      s.res.write(JSON.stringify(row) + '\n'); sent++;
    }
    console.log(`emit ${row.channel} ts=${ts} -> ${sent} subscriber(s)`);
    json(200, { ts, delivered_to: sent });
  });

  if ((url.pathname === '/say' || url.pathname === '/react') && req.method === 'POST') return body().then((b) => {
    console.log(`${url.pathname} ${JSON.stringify(b)}`);
    json(200, { ok: true, ts: `${now()}.999999` });
  });

  return json(404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`fake hub on http://127.0.0.1:${server.address().port}`));
