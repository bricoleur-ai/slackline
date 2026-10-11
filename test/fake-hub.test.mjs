// test/live/fake-hub.mjs stands in for the hub during live adapter checks. If it mis-serves the
// /tail contract, every live check built on it is meaningless — so it is itself checked against
// the real client, RemoteTail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RemoteTail } from '../remote.mjs';

const HUB = fileURLToPath(new URL('./live/fake-hub.mjs', import.meta.url));

function startHub(t) {
  const child = spawn(process.execPath, [HUB, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = out.match(/fake hub on (http:\/\/127\.0\.0\.1:\d+)/); if (m) resolve({ url: m[1], log: () => out }); });
    child.on('exit', (code) => reject(new Error(`fake hub exited ${code}`)));
  });
}
const post = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
async function until(cond, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise(r => setTimeout(r, 25)); } return false; }

test('an emitted message reaches a RemoteTail subscribed to that workspace and channel, and no other', async (t) => {
  const hub = await startHub(t);
  const got = [], other = [];
  const mine = new RemoteTail({ url: hub.url, org: 'testorg' }, { channels: ['CTEST'], onMessage: (r) => got.push(r) });
  const theirs = new RemoteTail({ url: hub.url, org: 'testorg' }, { channels: ['COTHER'], onMessage: (r) => other.push(r) });
  t.after(() => { mine.stop(); theirs.stop(); });
  await mine.connect(); await theirs.connect();
  assert.ok(await until(async () => (await (await fetch(hub.url + '/subscribers')).json()).length === 2));

  const r = await post(hub.url + '/emit', { org: 'testorg', channel: 'CTEST', text: 'ping', user_name: 'Tester' });
  assert.equal(r.delivered_to, 1);
  assert.ok(await until(() => got.length === 1));
  assert.deepEqual([got[0].channel, got[0].text, got[0].user_name, got[0].origin, got[0].ts], ['CTEST', 'ping', 'Tester', 'human', r.ts]);
  assert.equal(other.length, 0);
  assert.equal((await post(hub.url + '/emit', { org: 'elsewhere', channel: 'CTEST' })).delivered_to, 0);
});

test('/say is accepted and logged, so a live check can see an agent reply', async (t) => {
  const hub = await startHub(t);
  const r = await post(hub.url + '/say', { org: 'testorg', channel: 'CTEST', text: 'PONG', thread_ts: '1.1' });
  assert.equal(r.ok, true);
  assert.ok(await until(() => /\/say .*"text":"PONG"/.test(hub.log())));
  assert.equal((await (await fetch(hub.url + '/health')).json()).ok, true);
});
