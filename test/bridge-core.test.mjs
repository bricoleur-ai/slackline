// Shared bridge-core behavior. Each guard here exists because its absence caused a real failure
// (see bridges/core.mjs) — these tests keep any of them from regressing. No network: globalThis.fetch is stubbed per-test (same pattern as
// test/transport-socket.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../bridges/core.mjs';
import { MemoryStore } from '../stores/memory.mjs';

function creds(over = {}) {
  return { mode: 'app', org: 'test-org', bot_user_id: 'UBOT', bot_id: 'BBOT',
    bot_token: 'xoxb-test', team_name: 'Test Team', ...over };
}

async function makeStore() { const s = new MemoryStore(); await s.init(); return s; }

function jsonRes(body) { return { ok: true, json: async () => body }; }

// Stubs both Web API calls (…/api/<method>) and raw attachment downloads. Records every URL
// hit so tests can assert calls were (or were not) made. reactions.add is deliberately NOT
// stubbed: the bridge must never react to messages it merely saw, so any regression that
// reintroduces the 👀 receipt throws 'unstubbed slack method: reactions.add' rather than
// passing quietly.
function makeSlackFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes('/api/')) return { ok: true, arrayBuffer: async () => Buffer.from('filedata') };
    const method = u.split('/api/')[1];
    if (overrides[method]) return jsonRes(await overrides[method](u));
    const defaults = {
      'chat.getPermalink': { ok: true, permalink: 'https://example.slack.com/archives/C1/p1110000001' },
      'users.info': { ok: true, user: { name: 'sam', real_name: 'Sam Reporter', profile: {}, is_bot: false } },
      'conversations.history': { ok: true, messages: [] },
    };
    if (method in defaults) return jsonRes(defaults[method]);
    throw new Error('unstubbed slack method: ' + method);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function withFetch(t, fetchImpl) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => { globalThis.fetch = real; });
}

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slackline-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('origin=hub messages are dropped — the agent never reacts to its own posts', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  await bridge.handle({ channel: 'C1', ts: '111.1', user: 'U1', text: 'hello', origin: 'hub' });

  assert.equal(delivered.length, 0);
  assert.equal(fetchImpl.calls.length, 0, 'no Slack API calls for a hub-origin message');
  assert.equal(readdirSync(dir).length, 0);
});

test('slash-command echoes are skipped — Slack posts some as ordinary messages with no subtype', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  await bridge.handle({ channel: 'C1', ts: '111.2', user: 'U1', text: '/invite @bot', origin: 'peer' });

  assert.equal(delivered.length, 0);
  assert.equal(fetchImpl.calls.length, 0, 'slash-command echoes must not even reach the ack/report path');
  assert.equal(readdirSync(dir).length, 0);
});

test('a channel filter drops messages from other channels', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  await bridge.handle({ channel: 'C-OTHER', ts: '111.3', user: 'U1', text: 'hi', origin: 'peer' });

  assert.equal(delivered.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('reaction/edit/delete records (rec.type set) are not treated as QA reports', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  await bridge.handle({ channel: 'C1', ts: '111.4', type: 'reaction_added', emoji: 'thumbsup' });

  assert.equal(delivered.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a normal human message is written to a report file and delivered, with no reaction', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p, meta) => delivered.push({ p, meta }) });

  await bridge.handle({ channel: 'C1', ts: '1700000000.000100', user: 'U1', text: 'it broke', origin: 'peer' });

  assert.ok(!fetchImpl.calls.some(u => u.includes('/api/reactions.add')),
    'must NOT react — seeing a message is not a reason to write to the channel humans read');
  assert.equal(delivered.length, 1);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const content = readFileSync(join(dir, files[0]), 'utf8');
  assert.match(content, /# Slack message from Sam Reporter/);
  assert.match(content, /it broke/);
  assert.match(content, /## Replying/);
  assert.match(content, /scripts\/slack-reply\.mjs --thread 1700000000\.000100/);
  assert.match(delivered[0].p, /details and how to reply are in/);
});

test('the report states facts only — no instructions dictating how the agent should behave', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async () => {} });

  await bridge.handle({ channel: 'C1', ts: '1700000000.000200', user: 'U1', text: 'button is broken', origin: 'peer' });

  const files = readdirSync(dir);
  const content = readFileSync(join(dir, files[0]), 'utf8').toLowerCase();
  const forbidden = ['you must', 'you should', 'please respond', 'respond promptly', 'top priority',
    'must reply', 'as soon as possible', 'please fix', 'please investigate'];
  for (const phrase of forbidden) assert.ok(!content.includes(phrase), `report must not say "${phrase}"`);
  // Facts that ARE expected: source, workspace, sender, time, the message, and the reply mechanism.
  for (const must of ['source', 'workspace', 'from', 'posted', 'message ts', '## message', '## replying']) {
    assert.ok(content.includes(must), `report is missing expected fact section "${must}"`);
  }
});

test('attachments are downloaded and referenced in both the report and the pointer', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  const files_json = JSON.stringify([{ id: 'F1', name: 'screenshot.png', mimetype: 'image/png', url: 'https://files.slack.com/F1' }]);
  await bridge.handle({ channel: 'C1', ts: '1700000000.000300', user: 'U1', text: 'see attached', origin: 'peer', has_files: true, files_json });

  const saved = readdirSync(dir).filter(f => f.startsWith('F1_'));
  assert.equal(saved.length, 1, 'attachment must be downloaded into the QA dir');
  assert.match(delivered[0], /1 attachment/);
  const reportFile = readdirSync(dir).find(f => f.startsWith('qa-'));
  const content = readFileSync(join(dir, reportFile), 'utf8');
  assert.match(content, /## Attachments/);
  assert.match(content, /screenshot\.png/);
});

test('durable dedupe: an existing report file on disk blocks a re-handle even with a FRESH in-memory Set', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const ts = '1700000000.000400';
  // Simulate a prior process run having already produced the report (durable marker) —
  // this bridge instance's `seen` Set is brand new, exactly like after a restart.
  writeFileSync(join(dir, `qa-${ts.replace('.', '-')}.md`), 'already handled by a prior run');
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  await bridge.handle({ channel: 'C1', ts, user: 'U1', text: 'redelivered by Slack', origin: 'peer' });

  assert.equal(delivered.length, 0, 'must not re-deliver');
  assert.equal(fetchImpl.calls.length, 0, 'must not even re-ack — the file check happens before any API call');
});

test('a second in-process handle() of the same ts is also deduped (in-memory fast path)', async (t) => {
  const fetchImpl = makeSlackFetch();
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  const rec = { channel: 'C1', ts: '1700000000.000500', user: 'U1', text: 'dup', origin: 'peer' };
  await bridge.handle(rec);
  await bridge.handle(rec);

  assert.equal(delivered.length, 1);
});

test('backfill sweeps unhandled history into handle(), skipping our own posts and ones already reported', async (t) => {
  const fetchImpl = makeSlackFetch({
    'conversations.history': () => ({ ok: true, messages: [
      // Already handled — a report file exists for it (written below). Must be skipped.
      { ts: '1700000000.000600', user: 'U2', text: 'old, already handled' },
      // Our own post — must be skipped.
      { ts: '1700000000.000700', user: 'UBOT', text: 'our own message' },
      // Genuinely pending — must be relayed.
      { ts: '1700000000.000800', user: 'U3', text: 'never handled' },
      // System subtype — must be skipped.
      { ts: '1700000000.000900', subtype: 'channel_join', user: 'U4', text: 'joined' },
    ] }),
  });
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  const bridge = createBridge({ store: await makeStore(), creds: creds(), channel: 'C1',
    channelName: '#qa', qaDir: dir, log: () => {}, deliver: async (p) => delivered.push(p) });

  // The durable marker: a report already on disk means that message was handled in an
  // earlier run, even though this process has an empty in-memory `seen`.
  writeFileSync(join(dir, 'qa-1700000000-000600.md'), '# handled in a previous run\n');

  await bridge.backfill();

  assert.equal(delivered.length, 1, 'only the genuinely-pending message is relayed');
  const reportFiles = readdirSync(dir).filter(f => f.startsWith('qa-')).sort();
  // Two on disk: the pre-existing marker we planted, plus the one just written for 000800.
  assert.deepEqual(reportFiles, ['qa-1700000000-000600.md', 'qa-1700000000-000800.md']);
  assert.match(delivered[0], /1700000000-000800/, 'the pointer must point at that message\'s report file');
});

// The property that actually matters across a restart: sweeping the same history twice must
// not relay the same message twice. The report file carries this (not a Slack reaction), so a second
// sweep with a fresh in-memory `seen` must still find nothing pending.
test('backfill is idempotent: sweeping the same history twice delivers once', async (t) => {
  const fetchImpl = makeSlackFetch({
    'conversations.history': () => ({ ok: true, messages: [
      { ts: '1700000001.0001', user: 'U2', text: 'needs handling' },
    ] }),
  });
  withFetch(t, fetchImpl);
  const dir = tmpDir(t);
  const delivered = [];
  // A fresh bridge over the SAME qaDir is what a restart looks like: the report files persist,
  // the in-memory `seen` does not. Only the on-disk marker can carry idempotence across that.
  const newBridge = async () => createBridge({ store: await makeStore(), creds: creds(),
    channel: 'C1', channelName: '#qa', qaDir: dir, log: () => {},
    deliver: async (p) => delivered.push(p) });

  await (await newBridge()).backfill();
  assert.equal(delivered.length, 1, 'first sweep relays it');

  await (await newBridge()).backfill();
  assert.equal(delivered.length, 1, 'a restart must not relay it again');
});
