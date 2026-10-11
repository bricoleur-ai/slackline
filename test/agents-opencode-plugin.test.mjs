// The OpenCode adapter runs inside the OpenCode process and injects each Slack message as a
// prompt. It has to choose a session to inject into (the root session the operator is actually
// using, never a subagent's), and hold a message that arrives before any session exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../agents/opencode/plugin.mjs';
import { createPush } from '../agents/opencode/push.mjs';

// parents: session id -> parentID, for sessions the plugin has to look up.
function stubClient({ parents = {}, failWith = null } = {}) {
  const sent = [], lookups = [];
  return { sent, lookups, session: {
    promptAsync: async ({ path, body }) => {
      if (failWith) return { error: failWith };
      sent.push({ id: path.id, text: body.parts[0].text, type: body.parts[0].type }); return { data: {} };
    },
    get: async ({ path }) => { lookups.push(path.id); return { data: { id: path.id, parentID: parents[path.id] } }; },
  } };
}
function fakeOpen() {
  const h = { onRow: null, stopped: false, opened: 0 };
  return { h, open: ({ onRow }) => { h.opened++; h.onRow = onRow; return { ready: Promise.resolve(), stop() { h.stopped = true; } }; } };
}
const row = (text, ts = '1.1') => ({ channel: 'C1', channel_name: '#dev', ts, user: 'U1', user_name: 'Jane', origin: 'human', text });
const cfg = { url: 'http://hub' }, streams = [{ org: 'acme', channels: ['C1'] }];
const ev = (type, properties) => ({ event: { type, properties } });
const made = (id, parentID) => ev('session.created', { info: { id, parentID } });

test('the plugin module exports exactly one thing: the plugin function', () => {
  assert.deepEqual(Object.keys(plugin), ['SlacklinePlugin'], 'OpenCode calls every export of a plugin module as a plugin');
  assert.equal(typeof plugin.SlacklinePlugin, 'function');
});

test('a message is injected into the current root session as one text part carrying the envelope', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  await p.event(made('ses_root'));
  h.onRow(row('ship it?'), 'acme');
  await p.idle();
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].id, 'ses_root');
  assert.equal(client.sent[0].type, 'text');
  assert.match(client.sent[0].text, /^<channel source="slackline" org="acme" channel="C1"/);
  assert.match(client.sent[0].text, /\nJane: ship it\?\n<\/channel>$/);
});

test('a message that arrives before any session exists is held, then delivered to the first root session', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  h.onRow(row('early'), 'acme');
  await p.idle();
  assert.deepEqual([client.sent.length, p.held], [0, 1]);
  await p.event(made('ses_root'));
  assert.deepEqual([client.sent.length, client.sent[0].id, p.held], [1, 'ses_root', 0]);
});

test('a subagent session is never targeted', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  await p.event(made('ses_root'));
  await p.event(made('ses_child', 'ses_root'));
  await p.event(ev('session.idle', { sessionID: 'ses_child' }));
  await p.event(ev('message.updated', { info: { sessionID: 'ses_child' } }));
  h.onRow(row('hello'), 'acme');
  await p.idle();
  assert.equal(client.sent[0].id, 'ses_root');
});

test('the most recently active root session wins', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  await p.event(made('ses_a')); await p.event(made('ses_b'));
  assert.equal(p.current, 'ses_b');
  await p.event(ev('message.updated', { info: { sessionID: 'ses_a' } }));
  h.onRow(row('hello'), 'acme');
  await p.idle();
  assert.equal(client.sent[0].id, 'ses_a');
});

test('a session resumed before the plugin loaded is looked up once to learn whether it is a root', async () => {
  const client = stubClient({ parents: { ses_sub: 'ses_old' } }); const { open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  await p.event(ev('session.idle', { sessionID: 'ses_sub' }));
  assert.equal(p.current, null, 'a looked-up subagent session is not adopted');
  await p.event(ev('session.idle', { sessionID: 'ses_old' }));
  await p.event(ev('session.idle', { sessionID: 'ses_old' }));
  assert.equal(p.current, 'ses_old');
  assert.deepEqual(client.lookups, ['ses_sub', 'ses_old'], 'each session is looked up at most once');
});

test('deleting the current session clears it; later messages are held again', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  await p.event(made('ses_root'));
  await p.event(ev('session.deleted', { info: { id: 'ses_root' } }));
  h.onRow(row('anyone?'), 'acme');
  await p.idle();
  assert.deepEqual([p.current, client.sent.length, p.held], [null, 0, 1]);
});

test('at most 50 messages are held; the oldest are dropped', async () => {
  const client = stubClient(); const { h, open } = fakeOpen();
  const p = createPush({ client, directory: '/proj', cfg, streams, open });
  p.start();
  for (let i = 0; i < 60; i++) h.onRow(row(`m${i}`, `1.${i}`), 'acme');
  await p.idle();
  assert.equal(p.held, 50);
  await p.event(made('ses_root'));
  assert.equal(client.sent.length, 50);
  assert.match(client.sent[0].text, /Jane: m10\n/);
});

test('a rejected prompt is logged and dropped — at most once, never retried — and later messages still flow', async () => {
  const client = stubClient({ failWith: { name: 'BadRequest' } }); const { h, open } = fakeOpen();
  const logs = [];
  const p = createPush({ client, directory: '/proj', cfg, streams, open, log: (m) => logs.push(m) });
  p.start();
  await p.event(made('ses_root'));
  h.onRow(row('top secret body'), 'acme');
  await p.idle();
  assert.equal(p.held, 0);
  assert.ok(logs.some(m => /promptAsync failed for acme\/C1\/1\.1/.test(m)));
  assert.ok(logs.every(m => !m.includes('top secret body')));
});

test('with no hub configured or nothing routed, no stream is opened and events are harmless', async () => {
  for (const over of [{ cfg: null }, { streams: [] }]) {
    const client = stubClient(); const { h, open } = fakeOpen();
    const p = createPush({ client, directory: '/proj', cfg, streams, open, ...over });
    p.start();
    await p.event(made('ses_root'));
    await p.event({ event: null });
    assert.equal(h.opened, 0);
    p.stop();
  }
});

test('stop() closes the streams', () => {
  const { h, open } = fakeOpen();
  const p = createPush({ client: stubClient(), directory: '/proj', cfg, streams, open });
  p.start(); p.stop();
  assert.equal(h.stopped, true);
});
