import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../slack.mjs';

function captureFetch(reply = { ok: true }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body.toString() });
    return { json: async () => reply };
  };
  return calls;
}

test('user mode puts the token in the body and the cookie in headers', async () => {
  const calls = captureFetch();
  await api({ mode: 'user', token: 'xoxc-U', cookie: 'C' }, 'auth.test', { foo: 'bar' });
  assert.equal(calls[0].url, 'https://slack.com/api/auth.test');
  assert.match(calls[0].body, /token=xoxc-U/);
  assert.match(calls[0].body, /foo=bar/);
  assert.equal(calls[0].init.headers.Cookie, 'd=C');
});

test('app mode puts the bot token in the header and NOT in the body', async () => {
  const calls = captureFetch();
  await api({ mode: 'app', bot_token: 'xoxb-B', app_token: 'xapp-A' }, 'chat.postMessage', { channel: 'C1' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-B');
  assert.equal(calls[0].body.includes('token='), false, 'bot token must not ride in the body');
  assert.equal(calls[0].body.includes('xapp-'), false, 'app token must never reach the Web API');
  assert.match(calls[0].body, /channel=C1/);
});

test('returns the parsed json body', async () => {
  captureFetch({ ok: true, user_id: 'U9' });
  const r = await api({ mode: 'user', token: 't', cookie: 'c' }, 'auth.test');
  assert.equal(r.user_id, 'U9');
});
