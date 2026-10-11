import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../db.mjs';

const sample = { org: 'acme', app_id: 'A1', team_id: 'T1', team_name: 'Acme',
  bot_token: 'xoxb-B', app_token: 'xapp-A', bot_user_id: 'UBOT', bot_id: 'BBOT' };

for (const backend of ['memory', 'sqlite::memory:']) {
  test(`${backend}: round-trips an app credential`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putApp(sample);
    const got = await s.getApp('acme');
    assert.equal(got.app_id, 'A1');
    assert.equal(got.bot_token, 'xoxb-B');
    assert.equal(got.app_token, 'xapp-A');
    assert.equal(got.bot_id, 'BBOT');
  });

  test(`${backend}: getApp returns null for an unknown org`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    assert.equal(await s.getApp('nope'), null);
  });

  test(`${backend}: putApp upserts rather than duplicating`, async () => {
    process.env.SLACKLINE_STORE = backend;
    const s = createStore(); await s.init();
    await s.putApp(sample);
    await s.putApp({ ...sample, bot_token: 'xoxb-ROTATED' });
    assert.equal((await s.listApps()).length, 1);
    assert.equal((await s.getApp('acme')).bot_token, 'xoxb-ROTATED');
  });
}
