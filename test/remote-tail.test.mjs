// Unit tests for RemoteTail (remote.mjs): the reconnecting /tail subscription that backs
// channel push in remote-client mode. Stubs global fetch with a fake NDJSON body (an async
// generator of Uint8Array chunks) — no real network, no real hub. Proves: (1) a dropped stream
// reconnects and resumes with ?since=<last ts>, not from scratch and not replaying the gap;
// (2) two instances never share a watermark (the /tmp/slackline_since bug this replaces);
// (3) an unreachable hub at startup fails loudly instead of vanishing into the retry loop;
// (4) SLACKLINE_CHANNEL_ONLY and the origin=human,peer drop are both on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTail } from '../remote.mjs';

const enc = new TextEncoder();
function bodyFromLines(lines) {
  return { async *[Symbol.asyncIterator]() { for (const l of lines) yield enc.encode(l + '\n'); } };
}
function okRes(lines) { return { ok: true, status: 200, headers: { get: () => 'application/x-ndjson' }, body: bodyFromLines(lines) }; }

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test('connect() reads plain message rows and advances the watermark from their ts', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: 'acme' };
  const rows = [];
  const line1 = JSON.stringify({ channel: 'C1', ts: '1700000000.000100', text: 'hi', origin: 'peer' });
  const line2 = JSON.stringify({ channel: 'C1', ts: '1700000001.000200', text: 'yo', origin: 'peer' });
  await withFetch(async () => okRes([line1, line2]), async () => {
    // connect() resolves once the stream is ESTABLISHED and then consumes in the background —
    // it deliberately does not await the read loop, because a long-lived stream would never
    // return. So wait on the rows themselves rather than on connect(). Resolving from inside
    // the 2nd row's callback keeps this deterministic: no sleep, and stop() fires before the
    // background reconnect loop can.
    let bothArrived;
    const done = new Promise((res) => { bothArrived = res; });
    const tail = new RemoteTail(cfg, { onMessage: (r) => { rows.push(r); if (rows.length === 2) { tail.stop(); bothArrived(); } }, backoffStart: 1000 });
    await tail.connect();
    await done;
    assert.equal(rows.length, 2);
    assert.equal(tail.since, '1700000001.000200');
  });
});

test('a reconnect resumes with ?since=<last ts> — no gap, no replay from scratch', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: 'acme' };
  const calls = [];
  const first = [JSON.stringify({ channel: 'C1', ts: '1700000000.000100', text: 'a', origin: 'peer' })];
  const second = [JSON.stringify({ channel: 'C1', ts: '1700000002.000300', text: 'b', origin: 'peer' })];
  let n = 0;
  await withFetch(async (u) => {
    calls.push(new URL(u));
    n++;
    return n === 1 ? okRes(first) : okRes(second);
  }, async () => {
    const tail = new RemoteTail(cfg, { channels: ['C1'], onMessage: () => {}, backoffStart: 1, backoffMax: 5 });
    await tail.connect();                         // first attempt: connects, drains `first`, stream ends
    await new Promise((r) => setTimeout(r, 30));   // let the background loop reconnect at least once
    tail.stop();
  });
  assert.ok(calls.length >= 2, `expected at least 2 fetches, got ${calls.length}`);
  assert.equal(calls[0].searchParams.has('since'), false);         // first connect: no replay requested
  assert.equal(calls[1].searchParams.get('since'), '1700000000.000100');   // reconnect: resumes from last seen ts
});

test('two RemoteTail instances never share a watermark', async () => {
  const cfgA = { url: 'http://hub:8790', secret: '', org: 'acme' };
  const cfgB = { url: 'http://hub:8790', secret: '', org: 'acme' };
  const lineA = JSON.stringify({ channel: 'CA', ts: '1700000010.000100', text: 'a', origin: 'peer' });
  const lineB = JSON.stringify({ channel: 'CB', ts: '1700000099.000900', text: 'b', origin: 'peer' });
  await withFetch(async (u) => {
    const url = new URL(u);
    return url.searchParams.get('channels') === 'CA' ? okRes([lineA]) : okRes([lineB]);
  }, async () => {
    const tailA = new RemoteTail(cfgA, { channels: ['CA'], onMessage: () => {}, backoffStart: 1 });
    const tailB = new RemoteTail(cfgB, { channels: ['CB'], onMessage: () => {}, backoffStart: 1 });
    const dA = tailA.connect(), dB = tailB.connect();
    await new Promise((r) => setTimeout(r, 20));
    tailA.stop(); tailB.stop();
    await Promise.all([dA, dB]);
    assert.equal(tailA.since, '1700000010.000100');
    assert.equal(tailB.since, '1700000099.000900');
    assert.notEqual(tailA.since, tailB.since);
  });
});

test('an unreachable hub at startup rejects connect() immediately — no silent retry loop', async () => {
  const cfg = { url: 'http://hub.example.com:8790', secret: 'do-not-print', org: 'acme' };
  let fetchCalls = 0;
  await withFetch(async () => { fetchCalls++; throw new Error('ECONNREFUSED'); }, async () => {
    const tail = new RemoteTail(cfg, { onMessage: () => {}, backoffStart: 1 });
    await assert.rejects(tail.connect(), (e) => {
      assert.match(e.message, /hub.example.com:8790/);
      assert.ok(!e.message.includes('do-not-print'));
      return true;
    });
  });
  // connect()'s first attempt is NOT swallowed into the background loop — exactly one fetch,
  // and the promise it returns rejects synchronously with the failure (a caller can process.exit).
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetchCalls, 1);
});

test('a 401 from the hub at startup also fails loud, with the hub\'s error body', async () => {
  const cfg = { url: 'http://hub:8790', secret: 'wrong', org: 'acme' };
  await withFetch(async () => ({ ok: false, status: 401, statusText: 'Unauthorized', headers: { get: () => 'application/json' }, text: async () => '{"error":"unauthorized"}' }), async () => {
    const tail = new RemoteTail(cfg, { onMessage: () => {}, backoffStart: 1 });
    await assert.rejects(tail.connect(), /401.*unauthorized/s);
  });
});

test('the /tail URL carries SLACKLINE_CHANNEL_ONLY channels and drops origin=hub at the source', async () => {
  const cfg = { url: 'http://hub:8790', secret: 's', org: 'acme' };
  let seen;
  await withFetch(async (u, opts) => { seen = { url: new URL(u), opts }; return okRes([]); }, async () => {
    const tail = new RemoteTail(cfg, { channels: ['C1', 'C2'], onMessage: () => {}, backoffStart: 1 });
    await tail.connect();
    await new Promise((r) => setTimeout(r, 5));
    tail.stop();
  });
  assert.equal(seen.url.pathname, '/tail');
  assert.equal(seen.url.searchParams.get('org'), 'acme');
  assert.equal(seen.url.searchParams.get('channels'), 'C1,C2');
  assert.equal(seen.url.searchParams.get('origin'), 'human,peer');
  assert.equal(seen.opts.headers['x-slackline-secret'], 's');
});

test('typed events (reaction_added etc) are routed to onEvent, not onMessage, and never move the watermark', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: 'acme' };
  const msgs = [], events = [];
  const reaction = JSON.stringify({ type: 'reaction_added', channel: 'C1', ts: '1699999999.000000', emoji: 'eyes' });
  const message = JSON.stringify({ channel: 'C1', ts: '1700000005.000000', text: 'hi', origin: 'peer' });
  let tail;
  await withFetch(async () => okRes([reaction, message]), async () => {
    tail = new RemoteTail(cfg, { onMessage: (r) => { msgs.push(r); tail.stop(); }, onEvent: (r) => events.push(r), backoffStart: 1000 });
    await tail.connect();
  });
  assert.equal(events.length, 1);
  assert.equal(msgs.length, 1);
  assert.equal(tail.since, '1700000005.000000');   // the reaction's (older/unrelated) ts must never set the watermark
});
