// Unit tests for slack.mjs's backfillChannel — the "look back" capability slack_recent/
// slack_search never had (they only read the rolling store, which fills from live traffic).
// No real network: globalThis.fetch is stubbed (same technique as api-shape.test.mjs and
// bridge-core.test.mjs). Proves: cursor pagination, the page/limit caps, origin classification
// for app vs. user mode, idempotent re-runs, not_in_channel surfacing distinctly, and 429 honored
// with Retry-After (bounded, never an infinite retry loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillChannel } from '../slack.mjs';
import { MemoryStore } from '../stores/memory.mjs';

async function makeStore() { const s = new MemoryStore(); await s.init(); return s; }

const appCreds = { mode: 'app', org: 'acme', bot_user_id: 'UBOT', bot_id: 'BBOT', bot_token: 'xoxb-t' };
const userCreds = { mode: 'user', org: 'acme', user_id: 'UME', token: 'xoxc-t', cookie: 'd-cookie' };

function msg(ts, over = {}) { return { type: 'message', user: 'UOTHER', text: `m${ts}`, ts: String(ts), ...over }; }

// Queue-based fetch stub: each call to conversations.history pops the next scripted response.
// A response can set status/headers to simulate a 429; otherwise defaults to a 200 JSON body.
function queuedFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: init.body.toString() });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { status: r.status ?? 200, headers: { get: (h) => (r.headers && r.headers[h.toLowerCase()]) ?? null },
      json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

test('pagination follows response_metadata.next_cursor across pages', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [msg(3), msg(2)], has_more: true, response_metadata: { next_cursor: 'CUR1' } } },
    { body: { ok: true, messages: [msg(1)], has_more: false, response_metadata: { next_cursor: '' } } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', { limit: 100, pages: 5 }));
  assert.equal(fetchImpl.calls.length, 2, 'two pages fetched');
  assert.match(fetchImpl.calls[1].body, /cursor=CUR1/, 'second call carries the cursor from page 1');
  assert.equal(out.fetched, 3);
  assert.equal(out.stored, 3);
  assert.equal(out.has_more, false);
  assert.equal(out.oldest_ts, '1');
  assert.deepEqual(out.messages.map(m => m.ts), ['1', '2', '3'], 'returned ascending, ready for transcript()');
  assert.equal((await store.recent('acme', 'C1', 10)).length, 3);
});

test('the page cap bounds calls even when Slack still reports has_more', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [msg(5)], has_more: true, response_metadata: { next_cursor: 'A' } } },
    { body: { ok: true, messages: [msg(4)], has_more: true, response_metadata: { next_cursor: 'B' } } },
    { body: { ok: true, messages: [msg(3)], has_more: true, response_metadata: { next_cursor: 'C' } } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', { limit: 1000, pages: 2 }));
  assert.equal(fetchImpl.calls.length, 2, 'never exceeds the page cap');
  assert.equal(out.fetched, 2);
  assert.equal(out.has_more, true, 'still reports there is more — caller knows the backfill is incomplete');
});

test('the limit cap stops paging once enough messages are fetched', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [msg(9), msg(8)], has_more: true, response_metadata: { next_cursor: 'A' } } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', { limit: 2, pages: 10 }));
  assert.equal(fetchImpl.calls.length, 1, 'stopped after the first page satisfied the limit');
  assert.equal(out.fetched, 2);
});

test('app mode: our own bot post is tagged hub via bot_id, another bot is peer', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [
      msg(2, { user: 'UBOT', bot_id: 'BBOT' }),
      msg(1, { user: 'UOTHER', bot_id: 'BOTHER' }),
    ], has_more: false } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', {}));
  const byTs = Object.fromEntries(out.messages.map(m => [m.ts, m.origin]));
  assert.equal(byTs['2'], 'hub');
  assert.equal(byTs['1'], 'peer');
});

test('user mode: the connected account\'s own message is tagged hub, everyone else peer', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [msg(2, { user: 'UME' }), msg(1, { user: 'USOMEONE' })], has_more: false } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', userCreds, 'C1', {}));
  const byTs = Object.fromEntries(out.messages.map(m => [m.ts, m.origin]));
  assert.equal(byTs['2'], 'hub');
  assert.equal(byTs['1'], 'peer');
});

test('disallowed subtypes are counted as fetched but not stored, matching hydrateAround/hydrateThread', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([
    { body: { ok: true, messages: [
      msg(3, { subtype: 'channel_join' }),
      msg(2, { subtype: 'me_message' }),
      msg(1),
    ], has_more: false } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', {}));
  assert.equal(out.fetched, 3);
  assert.equal(out.stored, 2, 'channel_join dropped, me_message + plain kept');
  assert.deepEqual(out.messages.map(m => m.ts), ['1', '2']);
});

test('re-running backfill over the same window does not duplicate stored rows', async () => {
  const store = await makeStore();
  const page = { ok: true, messages: [msg(2), msg(1)], has_more: false };
  const out1 = await withFetch(queuedFetch([{ body: page }]), () => backfillChannel(store, 'acme', appCreds, 'C1', {}));
  const out2 = await withFetch(queuedFetch([{ body: page }]), () => backfillChannel(store, 'acme', appCreds, 'C1', {}));
  assert.equal(out1.stored, 2);
  assert.equal(out2.stored, 2, 'putMessage is idempotent — backfill still "stores" (upserts) both, no error');
  assert.equal((await store.recent('acme', 'C1', 10)).length, 2, 'but the store holds no duplicates');
});

test('not_in_channel surfaces as a distinct, legible error rather than an empty result', async () => {
  const store = await makeStore();
  const fetchImpl = queuedFetch([{ body: { ok: false, error: 'not_in_channel' } }]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', {}));
  assert.equal(out.error, 'not_in_channel');
  assert.equal(out.fetched, 0);
  assert.equal(out.stored, 0);
});

test('a 429 is retried honoring Retry-After, then succeeds', async () => {
  const store = await makeStore();
  const waits = [];
  const fetchImpl = queuedFetch([
    { status: 429, headers: { 'retry-after': '2' }, body: { ok: false, error: 'ratelimited' } },
    { body: { ok: true, messages: [msg(1)], has_more: false } },
  ]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1',
    { sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }));
  assert.deepEqual(waits, [2000], 'slept for Retry-After seconds, in ms');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(out.stored, 1);
});

test('a persistent 429 exhausts its retry budget instead of looping forever', async () => {
  const store = await makeStore();
  const waits = [];
  const fetchImpl = queuedFetch([{ status: 429, headers: { 'retry-after': '1' }, body: { ok: false, error: 'ratelimited' } }]);
  const out = await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1',
    { sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }));
  assert.equal(fetchImpl.calls.length, 4, 'initial attempt + 3 retries, then gives up');
  assert.equal(waits.length, 3);
  assert.equal(out.error, 'ratelimited');
  assert.equal(out.stored, 0);
});

test('files are archived through the same blobRoot mechanism as hydrateThread', async (t) => {
  const store = await makeStore();
  const dir = mkdtempSync(join(tmpdir(), 'slackline-history-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/conversations.history')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, has_more: false,
        messages: [msg(1, { files: [{ id: 'F1', name: 'x.png', mimetype: 'image/png', size: 3, url_private: 'https://files.slack.com/x.png' }] })] }) };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from('filedata') };
  };
  await withFetch(fetchImpl, () => backfillChannel(store, 'acme', appCreds, 'C1', { blobRoot: dir }));
  // archiveFiles is fire-and-forget (.catch swallows failures); give its microtask a tick.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some(u => u.includes('files.slack.com')), 'file download was attempted');
});
