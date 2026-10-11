// Unit tests for remote.mjs's non-streaming tool proxies. Stubs global fetch (no real network,
// no real hub) — proves the query params / body / response parsing for each tool, and that
// hub errors (network failure or non-2xx) surface with the hub URL + hub's error body, never
// as an empty success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteConfig, recent, thread, context, search, say, react, whoami } from '../remote.mjs';

function fakeJson(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
}

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

// NONE is a path that cannot exist, so these assertions describe env handling ONLY. Without
// it the suite would read the developer's real ~/.slackline/config.json and pass or fail
// depending on whose machine it ran on.
const NONE = '/nonexistent/slackline-config-for-tests.json';

test('remoteConfig reads env, null when unset, trims trailing slash', () => {
  assert.equal(remoteConfig({}, { configPath: NONE }), null);
  const cfg = remoteConfig({ SLACKLINE_REMOTE: 'http://hub.example.com:8790/', SLACKLINE_SECRET: 's3cr3t', SLACKLINE_ORG: 'globex' },
    { configPath: NONE });
  // `key` is part of the shape since scoped consumer keys landed — a key, when present,
  // takes precedence over the master secret (see authHeaders in remote.mjs).
  assert.deepEqual(cfg, { url: 'http://hub.example.com:8790', secret: 's3cr3t', key: '', org: 'globex' });
  // secret/org are optional
  assert.deepEqual(remoteConfig({ SLACKLINE_REMOTE: 'http://x:8790' }, { configPath: NONE }),
    { url: 'http://x:8790', secret: '', key: '', org: '' });
});

test('remoteConfig falls back to ~/.slackline/config.json, and env still wins', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slkcfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ hub: 'http://hub.example.com:8790/', key: 'slk_from_file', org: 'globex' }));

  // Nothing in env: the file supplies everything, and the hub URL is trimmed the same way.
  assert.deepEqual(remoteConfig({}, { configPath: cfgPath }),
    { url: 'http://hub.example.com:8790', secret: '', key: 'slk_from_file', org: 'globex' });

  // Env overrides file per-field — an explicit value must beat an ambient one.
  assert.deepEqual(remoteConfig({ SLACKLINE_KEY: 'slk_from_env' }, { configPath: cfgPath }),
    { url: 'http://hub.example.com:8790', secret: '', key: 'slk_from_env', org: 'globex' });
});

test('a malformed or absent config.json is ignored, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slkcfg-'));
  const bad = join(dir, 'config.json');
  writeFileSync(bad, 'not json at all {{{');
  // A stray unparseable file must not stop a consumer that configures everything through env.
  assert.deepEqual(remoteConfig({ SLACKLINE_REMOTE: 'http://x:8790' }, { configPath: bad }),
    { url: 'http://x:8790', secret: '', key: '', org: '' });
  assert.equal(remoteConfig({}, { configPath: bad }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('recent proxies GET /recent with org/channel/limit and returns the transcript', async () => {
  const cfg = { url: 'http://hub:8790', secret: 's', org: 'globex' };
  let seen;
  await withFetch(async (u, opts) => { seen = { u: new URL(u), opts }; return fakeJson(200, { transcript: '[10:00] alice: hi', messages: [] }); }, async () => {
    const out = await recent(cfg, { channel: 'C1', limit: 5 });
    assert.equal(out, '[10:00] alice: hi');
  });
  assert.equal(seen.u.pathname, '/recent');
  assert.equal(seen.u.searchParams.get('org'), 'globex');
  assert.equal(seen.u.searchParams.get('channel'), 'C1');
  assert.equal(seen.u.searchParams.get('limit'), '5');
  assert.equal(seen.opts.headers['x-slackline-secret'], 's');
});

test('recent falls back to a friendly message when transcript is empty', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { transcript: '', messages: [] }), async () => {
    assert.match(await recent(cfg, { channel: 'C1' }), /nothing stored yet/);
  });
});

test('thread proxies GET /thread and falls back when not found', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async (u) => {
    const url = new URL(u);
    assert.equal(url.pathname, '/thread');
    assert.equal(url.searchParams.get('thread_ts'), 'T1');
    return fakeJson(200, { transcript: '' });
  }, async () => {
    assert.match(await thread(cfg, { channel: 'C1', thread_ts: 'T1' }), /thread not found/);
  });
});

test('context prefixes the channel label, matching local mode\'s text() output', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { channel: '#general', transcript: '[10:00] bob: yo' }), async () => {
    const out = await context(cfg, { channel: 'C1', ts: '1.1' });
    assert.equal(out, 'channel #general\n[10:00] bob: yo');
  });
});

test('search rebuilds a transcript line from shaped /query results (no transcript field on the wire)', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async (u) => {
    const url = new URL(u);
    assert.equal(url.pathname, '/query');
    assert.equal(url.searchParams.get('q'), 'deploy');
    return fakeJson(200, { results: [
      { ts: '1700000000.000100', user_name: 'alice', text: 'deploy time\nline2', has_files: false, edited: false },
      { ts: '1700000060.000100', user_name: 'bob', text: 'ok', has_files: true, files: [{ name: 'x.png' }], edited: true },
    ] });
  }, async () => {
    const out = await search(cfg, { query: 'deploy', limit: 10 });
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[\d\d:\d\d\] alice: deploy time line2$/);       // newline collapsed like render.mjs
    assert.match(lines[1], /^\[\d\d:\d\d\] bob: ok \[file: x\.png\] \(edited\)$/);
  });
});

test('search falls back to a friendly message with no results', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async () => fakeJson(200, { results: [] }), async () => {
    assert.match(await search(cfg, { query: 'nope' }), /no matches/);
  });
});

test('say POSTs the exact body shape from the spec and reports the posted ts', async () => {
  const cfg = { url: 'http://hub:8790', secret: 'sek', org: 'globex' };
  let seen;
  await withFetch(async (u, opts) => { seen = opts; return fakeJson(200, { ok: true, ts: '1.1', channel: 'C1' }); }, async () => {
    assert.equal(await say(cfg, { channel: 'C1', text: 'hi', thread_ts: 'T1' }), 'posted ts=1.1');
  });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.body), { org: 'globex', channel: 'C1', text: 'hi', thread_ts: 'T1' });
});

test('say never leaks the secret into the request body', async () => {
  const cfg = { url: 'http://hub:8790', secret: 'top-secret-value', org: 'globex' };
  let seen;
  await withFetch(async (u, opts) => { seen = opts; return fakeJson(200, { ok: true, ts: '1.1' }); }, async () => {
    await say(cfg, { channel: 'C1', text: 'hi' });
  });
  assert.ok(!JSON.stringify(seen.body).includes('top-secret-value'));
  assert.equal(seen.headers['x-slackline-secret'], 'top-secret-value');   // only ever in the header
});

test('react POSTs /react and reports success', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async (u) => { assert.equal(new URL(u).pathname, '/react'); return fakeJson(200, { ok: true }); }, async () => {
    assert.equal(await react(cfg, { channel: 'C1', ts: '1.1', emoji: 'eyes' }), 'reacted');
  });
});

test('whoami reports the hub URL and orgs_live, and says identity is the hub\'s', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: '' };
  await withFetch(async (u) => { assert.equal(new URL(u).pathname, '/health'); return fakeJson(200, { ok: true, orgs_live: ['globex', 'acme'] }); }, async () => {
    const out = await whoami(cfg);
    assert.match(out, /hub's/);
    assert.match(out, /http:\/\/hub:8790/);
    assert.match(out, /globex, acme/);
  });
});

test('a failed /say (bad channel) throws loudly with the HTTP status and the hub\'s error body — never an empty success', async () => {
  const cfg = { url: 'http://hub:8790', secret: '', org: 'globex' };
  await withFetch(async () => fakeJson(400, { error: 'channel_not_found' }), async () => {
    await assert.rejects(say(cfg, { channel: 'CBAD', text: 'hi' }), /400.*channel_not_found/s);
  });
});

test('an unreachable hub throws with the hub URL and never the secret', async () => {
  const cfg = { url: 'http://hub.example.com:8790', secret: 'shh-do-not-print-me', org: 'globex' };
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    await assert.rejects(recent(cfg, { channel: 'C1' }), (e) => {
      assert.match(e.message, /hub.example.com:8790/);
      assert.ok(!e.message.includes('shh-do-not-print-me'));
      return true;
    });
  });
});
