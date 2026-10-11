import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, fileAuthHeaders } from '../slack.mjs';

const user = { mode: 'user', token: 'xoxc-USER', cookie: 'dcookie' };
const app  = { mode: 'app', bot_token: 'xoxb-BOT', app_token: 'xapp-APP' };

test('user mode authenticates with the d cookie, never a bearer', () => {
  const h = authHeaders(user);
  assert.equal(h.Cookie, 'd=dcookie');
  assert.equal(h.Authorization, undefined);
});

test('app mode authenticates with a bot bearer, never a cookie', () => {
  const h = authHeaders(app);
  assert.equal(h.Authorization, 'Bearer xoxb-BOT');
  assert.equal(h.Cookie, undefined);
});

test('app mode never leaks the app-level token into Web API calls', () => {
  // app_token is only valid for apps.connections.open; using it elsewhere fails.
  assert.equal(JSON.stringify(authHeaders(app)).includes('xapp-'), false);
});

test('missing mode defaults to user, so existing creds keep working', () => {
  const legacy = { token: 'xoxc-L', cookie: 'c' };
  assert.equal(authHeaders(legacy).Cookie, 'd=c');
});

test('file downloads send both cookie and bearer for user mode', () => {
  const h = fileAuthHeaders(user);
  assert.equal(h.Cookie, 'd=dcookie');
  assert.equal(h.Authorization, 'Bearer xoxc-USER');
});

test('file downloads send only the bot bearer for app mode', () => {
  const h = fileAuthHeaders(app);
  assert.equal(h.Authorization, 'Bearer xoxb-BOT');
  assert.equal(h.Cookie, undefined);
});
