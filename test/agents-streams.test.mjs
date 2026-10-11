// agents/streams.mjs opens the hub streams for a session that nobody is watching start (the
// Codex/Muse listener, the OpenCode plugin). Unlike mcp.mjs it must NOT die when the hub is
// down at that moment: the session would then never get a push, with nothing on screen to say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStreams } from '../agents/streams.mjs';

function fakeTail({ failFirst = 0, failWith = 'cannot reach slackline hub at http://hub', failOrgs = null } = {}) {
  const made = [];
  class FakeTail {
    constructor(cfg, opts) { this.cfg = cfg; this.opts = opts; this.connects = 0; this.stopped = false; this.left = failFirst; made.push(this); }
    async connect() {
      this.connects++;
      if (failOrgs && failOrgs[this.cfg.org]) throw new Error(failOrgs[this.cfg.org]);
      if (this.left > 0) { this.left--; throw new Error(failWith); }
    }
    stop() { this.stopped = true; }
  }
  return { FakeTail, made };
}
const cfg = { url: 'http://hub', key: 'slk_TESTKEY_9f31', org: 'default' };

test('opens one stream per workspace, with that workspace and its channels', async () => {
  const { FakeTail, made } = fakeTail();
  const h = openStreams({ cfg, streams: [{ org: 'a', channels: ['C1'] }, { org: 'b', channels: ['C2', 'C3'] }], onRow: () => {}, TailImpl: FakeTail });
  await h.ready;
  assert.deepEqual(made.map(t => [t.cfg.org, t.opts.channels, t.cfg.url]), [['a', ['C1'], 'http://hub'], ['b', ['C2', 'C3'], 'http://hub']]);
});

test('passes the workspace with each row and drops our own (hub-origin) posts', async () => {
  const { FakeTail, made } = fakeTail();
  const got = [];
  const h = openStreams({ cfg, streams: [{ org: 'a', channels: ['C1'] }], onRow: (row, org) => got.push([row.text, org]), TailImpl: FakeTail });
  await h.ready;
  made[0].opts.onMessage({ text: 'hi', origin: 'human' });
  made[0].opts.onMessage({ text: 'echo', origin: 'hub' });
  made[0].opts.onMessage({ text: 'yo', origin: 'peer' });
  assert.deepEqual(got, [['hi', 'a'], ['yo', 'a']]);
});

test('a hub that is down at start is retried with growing waits, not fatal', async () => {
  const { FakeTail, made } = fakeTail({ failFirst: 2 });
  const waits = [], logs = [];
  const h = openStreams({ cfg, streams: [{ org: 'a', channels: ['C1'] }], onRow: () => {}, TailImpl: FakeTail,
    sleepImpl: async (ms) => { waits.push(ms); }, log: (m) => logs.push(m) });
  await h.ready;
  assert.equal(made[0].connects, 3);
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(l => !l.includes('slk_TESTKEY_9f31')), 'a retry log line never carries the key');
});

test('stop() ends a retry loop and stops every stream; rows after stop are ignored', async () => {
  const { FakeTail, made } = fakeTail({ failFirst: Infinity });
  const got = []; let sleeps = 0, h;
  h = openStreams({ cfg, streams: [{ org: 'a', channels: ['C1'] }], onRow: (r) => got.push(r), TailImpl: FakeTail,
    sleepImpl: async () => { if (++sleeps === 2) h.stop(); } });
  await h.ready;
  assert.equal(made[0].connects, 2, 'no further attempts after stop');
  assert.equal(made[0].stopped, true);
  made[0].opts.onMessage({ text: 'late', origin: 'human' });
  assert.deepEqual(got, []);
});

for (const status of [401, 403]) {
  test(`a ${status} from the hub is logged once and not retried`, async () => {
    const { FakeTail, made } = fakeTail({ failFirst: Infinity, failWith: `hub GET /tail -> ${status}: forbidden` });
    const waits = [], logs = [];
    const h = openStreams({ cfg, streams: [{ org: 'typo', channels: ['C1'] }], onRow: () => {}, TailImpl: FakeTail,
      sleepImpl: async (ms) => { waits.push(ms); }, log: (m) => logs.push(m) });
    await h.ready;
    assert.equal(made[0].connects, 1, 'a refusal is never retried');
    assert.deepEqual(waits, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`refused.*"typo".*${status}`));
    assert.match(logs[0], /routes\.json/);
    assert.doesNotMatch(logs[0], /not reachable/);
    assert.ok(!logs[0].includes('slk_TESTKEY_9f31'));
  });
}

test('a refused stream does not stop the others in the same call from connecting', async () => {
  const { FakeTail, made } = fakeTail({ failOrgs: { bad: 'hub GET /tail -> 403: no such workspace' } });
  const h = openStreams({ cfg, streams: [{ org: 'bad', channels: ['C1'] }, { org: 'good', channels: ['C2'] }], onRow: () => {}, TailImpl: FakeTail, log: () => {} });
  await h.ready;
  assert.deepEqual(made.map(t => [t.cfg.org, t.connects]), [['bad', 1], ['good', 1]]);
});

test('a network failure still retries with the old wording', async () => {
  const { FakeTail, made } = fakeTail({ failFirst: 1 });
  const logs = [];
  const h = openStreams({ cfg, streams: [{ org: 'a', channels: ['C1'] }], onRow: () => {}, TailImpl: FakeTail, sleepImpl: async () => {}, log: (m) => logs.push(m) });
  await h.ready;
  assert.equal(made[0].connects, 2);
  assert.match(logs[0], /hub not reachable for a/);
});
