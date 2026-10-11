import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNormalizer } from '../normalize.mjs';

function fakeStore() {
  const msgs = [];
  return {
    msgs,
    putMessage: async (r) => { msgs.push(r); },
    getUser: async () => ({ updated: Date.now() }),
    getChannel: async () => ({ updated: Date.now() }),
    setReaction: async () => {},
    markDeleted: async () => {},
    isOutbound: async () => false,
    threadHydrated: async () => true,
    thread: async () => [],
    pendingOutbound: new Map(),
  };
}

const appCreds = { mode: 'app', org: 'acme', bot_user_id: 'UBOT', bot_id: 'BBOT' };

test('a plain message normalizes to a store record', async () => {
  const store = fakeStore();
  const n = makeNormalizer({ store, creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UHUMAN', text: 'hi', ts: '100.1' });
  assert.equal(rec.channel, 'C1');
  assert.equal(rec.text, 'hi');
  assert.equal(rec.origin, 'peer');
  assert.equal(rec.at, 100100);
});

test('RTM and Socket Mode shapes produce identical records', async () => {
  // Socket Mode adds event_ts/channel_type; the normalizer must ignore extras.
  const rtmEv    = { type: 'message', channel: 'C1', user: 'U2', text: 'same', ts: '200.5' };
  const socketEv = { ...rtmEv, event_ts: '200.5', channel_type: 'channel' };

  const a = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  const b = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  assert.deepEqual(await a(rtmEv), await b(socketEv));
});

test('app mode classifies our own bot post as hub via bot_id', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UBOT', bot_id: 'BBOT', text: 'mine', ts: '300.1' });
  assert.equal(rec.origin, 'hub');
});

test('app mode does not mistake another bot for us', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UOTHER', bot_id: 'BOTHER', text: 'x', ts: '301.1' });
  assert.equal(rec.origin, 'peer');
});

test('a silent unfurl updates the store but does not notify subscribers', async () => {
  const store = fakeStore();
  const n = makeNormalizer({ store, creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', subtype: 'message_changed', channel: 'C1',
    message: { ts: '400.1', text: 'unfurled', user: 'U2' } });
  assert.equal(rec, null, 'unfurls must not reach subscribers');
  assert.equal(store.msgs.length, 1, 'but the stored copy is still updated');
});

test('a real edit does notify subscribers', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', subtype: 'message_changed', channel: 'C1',
    message: { ts: '401.1', text: 'edited', user: 'U2', edited: { ts: '401.2' } } });
  assert.equal(rec.type, 'message_edited');
});

test('deletions are signalled and marked, not dropped', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '500.1' });
  assert.equal(rec.type, 'message_deleted');
  assert.equal(rec.deleted, true);
});

test('unsupported subtypes are dropped', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  assert.equal(await n({ type: 'message', subtype: 'channel_join', channel: 'C1', ts: '1.1' }), null);
});

test('non-message, non-reaction events are dropped', async () => {
  const n = makeNormalizer({ store: fakeStore(), creds: appCreds, opts: { hydrateThreads: false } });
  assert.equal(await n({ type: 'user_typing', channel: 'C1' }), null);
});

// --- Fix round 1: user-mode self-classification, reactions, thread hydration, isSelfAuthored parity ---

const userCreds = { mode: 'user', org: 'acme', user_id: 'UME' };

test('user mode: pendingOutbound fast path classifies as hub and clears the key', async () => {
  const store = fakeStore();
  const pkey = 'acme|C1|hi';
  store.pendingOutbound.set(pkey, Date.now() + 10000);
  const n = makeNormalizer({ store, creds: userCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UME', text: 'hi', ts: '100.1' });
  assert.equal(rec.origin, 'hub');
  assert.equal(store.pendingOutbound.has(pkey), false, 'the pending entry must be consumed, not left behind');
});

test('user mode: isOutbound true on the first check classifies as hub without polling', async () => {
  const store = fakeStore();
  let calls = 0;
  store.isOutbound = async () => { calls++; return true; };
  const n = makeNormalizer({ store, creds: userCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UME', text: 'hi', ts: '101.1' });
  assert.equal(rec.origin, 'hub');
  assert.equal(calls, 1, 'must resolve on the first check, never entering the retry loop');
});

test('user mode: a non-self author is peer without consulting the outbound guard', async () => {
  const store = fakeStore();
  store.isOutbound = async () => { throw new Error('outbound guard must not be consulted for a non-self author'); };
  const n = makeNormalizer({ store, creds: userCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UOTHER', text: 'x', ts: '102.1' });
  assert.equal(rec.origin, 'peer');
});

test('user mode: eventually classifies as human after exhausting the outbound rechecks', async () => {
  // Injects a synchronous stand-in for the 300ms sleep so the retry loop resolves instantly.
  const store = fakeStore();
  store.isOutbound = async () => false;
  const n = makeNormalizer({ store, creds: userCreds, opts: { hydrateThreads: false, sleep: () => Promise.resolve() } });
  const rec = await n({ type: 'message', channel: 'C1', user: 'UME', text: 'hi', ts: '103.1' });
  assert.equal(rec.origin, 'human');
});

test('an event with no user and no bot_id is never mistaken for self when user_id is unset', async () => {
  // Pins isSelfAuthored's user-mode fallback: (ev.user || ev.bot_id) === (creds.user_id || null).
  // Both sides must resolve to null here, not undefined === undefined.
  const store = fakeStore();
  store.isOutbound = async () => { throw new Error('must never reach the outbound guard'); };
  const n = makeNormalizer({ store, creds: { mode: 'user', org: 'acme' }, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'message', channel: 'C1', text: 'x', ts: '104.1' });
  assert.equal(rec.origin, 'peer');
});

test('reaction_added updates the store and returns a signal record', async () => {
  const store = fakeStore();
  const calls = [];
  store.setReaction = async (...args) => { calls.push(args); };
  const n = makeNormalizer({ store, creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'reaction_added', item: { type: 'message', channel: 'C1', ts: '200.1' },
    reaction: 'thumbsup', user: 'U2' });
  assert.deepEqual(calls[0], ['acme', 'C1', '200.1', 'thumbsup', 'U2', true]);
  assert.equal(rec.type, 'reaction_added');
  assert.equal(rec.channel, 'C1');
  assert.equal(rec.ts, '200.1');
  assert.equal(rec.emoji, 'thumbsup');
  assert.equal(rec.user, 'U2');
});

test('reaction_removed updates the store with added=false and returns a signal record', async () => {
  const store = fakeStore();
  const calls = [];
  store.setReaction = async (...args) => { calls.push(args); };
  const n = makeNormalizer({ store, creds: appCreds, opts: { hydrateThreads: false } });
  const rec = await n({ type: 'reaction_removed', item: { type: 'message', channel: 'C1', ts: '201.1' },
    reaction: 'thumbsup', user: 'U2' });
  assert.deepEqual(calls[0], ['acme', 'C1', '201.1', 'thumbsup', 'U2', false]);
  assert.equal(rec.type, 'reaction_removed');
  assert.equal(rec.emoji, 'thumbsup');
  assert.equal(rec.user, 'U2');
});

test('thread hydration fires for a reply', async () => {
  const store = fakeStore();
  const calls = [];
  const spyHydrate = (...args) => { calls.push(args); return Promise.resolve(); };
  const n = makeNormalizer({ store, creds: appCreds,
    opts: { hydrateThreads: true, hydrateThread: spyHydrate } });
  await n({ type: 'message', channel: 'C1', user: 'U2', text: 'reply', ts: '600.2', thread_ts: '600.1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [store, 'acme', appCreds, 'C1', '600.1']);
});

test('thread hydration does not fire for a top-level message', async () => {
  const store = fakeStore();
  const calls = [];
  const spyHydrate = (...args) => { calls.push(args); return Promise.resolve(); };
  const n = makeNormalizer({ store, creds: appCreds,
    opts: { hydrateThreads: true, hydrateThread: spyHydrate } });
  await n({ type: 'message', channel: 'C1', user: 'U2', text: 'top-level', ts: '601.1' });
  assert.equal(calls.length, 0, 'no thread_ts distinct from ts, so no hydration');
});

test('thread hydration does not fire for the thread root itself (thread_ts === ts)', async () => {
  const store = fakeStore();
  const calls = [];
  const spyHydrate = (...args) => { calls.push(args); return Promise.resolve(); };
  const n = makeNormalizer({ store, creds: appCreds,
    opts: { hydrateThreads: true, hydrateThread: spyHydrate } });
  await n({ type: 'message', channel: 'C1', user: 'U2', text: 'root', ts: '602.1', thread_ts: '602.1' });
  assert.equal(calls.length, 0);
});
