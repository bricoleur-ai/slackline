// Unit test for remote.mjs's history() proxy — same pattern as test/remote.test.mjs's other
// tool proxies (stubbed global fetch, no real hub, no real network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { history } from '../remote.mjs';

function fakeJson(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
}
function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

test('history proxies GET /history with org/channel/limit/oldest/latest and returns the transcript', async () => {
  const cfg = { url: 'http://hub:8790', secret: 's', org: 'acme' };
  let seen;
  await withFetch(async (u, opts) => { seen = { u: new URL(u), opts }; return fakeJson(200, { transcript: '[10:00] alice: old news', has_more: false }); }, async () => {
    const out = await history(cfg, { channel: 'C1', limit: 50, oldest: '1.0', latest: '2.0' });
    assert.equal(out, '[10:00] alice: old news');
  });
  assert.equal(seen.u.pathname, '/history');
  assert.equal(seen.u.searchParams.get('org'), 'acme');
  assert.equal(seen.u.searchParams.get('channel'), 'C1');
  assert.equal(seen.u.searchParams.get('limit'), '50');
  assert.equal(seen.u.searchParams.get('oldest'), '1.0');
  assert.equal(seen.u.searchParams.get('latest'), '2.0');
});

test('history appends a continuation hint when the hub reports has_more', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { transcript: '[10:00] alice: hi', has_more: true, oldest_ts: '1.100' }), async () => {
    const out = await history(cfg, { channel: 'C1' });
    assert.match(out, /\[10:00\] alice: hi/);
    assert.match(out, /oldest="1\.100"/);
  });
});

test('history falls back to a friendly message when nothing was found in range', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { transcript: '', has_more: false }), async () => {
    assert.match(await history(cfg, { channel: 'C1' }), /no messages in that range/);
  });
});

test('history reports not_in_channel as a friendly, distinct message (not a thrown hub error)', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { error: 'not_in_channel', transcript: '' }), async () => {
    const out = await history(cfg, { channel: 'C1' });
    assert.match(out, /not a member/);
    assert.match(out, /C1/);
  });
});

test('history surfaces any other backfill error plainly', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { error: 'invalid_auth', transcript: '' }), async () => {
    assert.equal(await history(cfg, { channel: 'C1' }), 'error: invalid_auth');
  });
});
