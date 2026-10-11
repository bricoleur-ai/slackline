import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCredsFromEnv, resolveCreds, ensureBotIdentity } from '../creds.mjs';

const clear = () => { for (const k of ['SLACKLINE_APP_TOKEN','SLACKLINE_BOT_TOKEN','SLACKLINE_XOXC','SLACKLINE_XOXD','SLACKLINE_TOKENS_FILE','SLACKLINE_ORG','SLACKLINE_USER'])
  delete process.env[k]; };

// Stubs global fetch for one auth.test round-trip; returns a restore() so later tests in this
// file (which rely on the real fetch failing fast, or on no network call happening at all) are
// never affected by a leftover stub.
function stubFetch(reply) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => reply });
  return () => { globalThis.fetch = real; };
}

test('builds app creds from env', () => {
  clear();
  process.env.SLACKLINE_APP_TOKEN = 'xapp-A';
  process.env.SLACKLINE_BOT_TOKEN = 'xoxb-B';
  const c = appCredsFromEnv();
  assert.equal(c.mode, 'app');
  assert.equal(c.app_token, 'xapp-A');
  assert.equal(c.bot_token, 'xoxb-B');
  clear();
});

test('returns null when either token is missing', () => {
  clear();
  process.env.SLACKLINE_APP_TOKEN = 'xapp-A';       // bot token absent
  assert.equal(appCredsFromEnv(), null);
  clear();
});

test('ensureBotIdentity maps auth.test fields without swapping user_id and bot_id', async () => {
  clear();
  const restore = stubFetch({ ok: true, user_id: 'U123', bot_id: 'B456', team: 'Acme', team_id: 'T1' });
  try {
    const creds = { mode: 'app', org: 'default', app_token: 'xapp-X', bot_token: 'xoxb-X', bot_id: null, bot_user_id: null };
    const out = await ensureBotIdentity(creds);
    // Distinct expected values so a swapped mapping (user_id <-> bot_id) would fail this, not
    // just fail to match "some string was assigned somewhere".
    assert.equal(out.bot_user_id, 'U123');
    assert.equal(out.bot_id, 'B456');
    assert.notEqual(out.bot_user_id, out.bot_id);
  } finally { restore(); clear(); }
});

test('ensureBotIdentity(creds, true) derives org from auth.test team when SLACKLINE_ORG is unset (env-sourced path)', async () => {
  clear();
  const restore = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme Corp', team_id: 'T1' });
  try {
    const creds = { mode: 'app', org: 'default', app_token: 'xapp-X', bot_token: 'xoxb-X', bot_id: null, bot_user_id: null };
    const out = await ensureBotIdentity(creds, true);
    assert.equal(out.org, 'Acme Corp');
  } finally { restore(); clear(); }
});

test('ensureBotIdentity does not override an explicitly configured SLACKLINE_ORG', async () => {
  clear();
  process.env.SLACKLINE_ORG = 'pinned-org';
  const restore = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme Corp', team_id: 'T1' });
  try {
    const creds = { mode: 'app', org: 'pinned-org', app_token: 'xapp-X', bot_token: 'xoxb-X', bot_id: null, bot_user_id: null };
    const out = await ensureBotIdentity(creds, true);
    assert.equal(out.org, 'pinned-org');
  } finally { restore(); clear(); }
});

// Regression (fix-round-final #4): store-sourced app credentials must NOT be renamed by
// auth.test's team display name — standalone.mjs/ingestd.mjs/server.mjs read a listApps() row
// keyed by its stored org, then compare that key against user-token orgs to decide app-over-user
// precedence. If ensureBotIdentity renamed org here (default call, no envSourced flag), a store
// row stored under 'default' would come back as 'Acme Corp' while a user token for 'default' is
// still sitting in the store — the skip check would miss it and both would ingest into two
// different partitions for the same workspace.
test('ensureBotIdentity leaves org untouched for store-sourced creds (envSourced omitted/false)', async () => {
  clear();
  const restore = stubFetch({ ok: true, user_id: 'U1', bot_id: 'B1', team: 'Acme Corp', team_id: 'T1' });
  try {
    const creds = { mode: 'app', org: 'default', app_token: 'xapp-X', bot_token: 'xoxb-X', bot_id: null, bot_user_id: null };
    const out = await ensureBotIdentity(creds);   // no envSourced arg -> defaults false
    assert.equal(out.org, 'default');
  } finally { restore(); clear(); }
});

test('ensureBotIdentity returns null (never a half-built credential) when auth.test is not ok', async () => {
  clear();
  const restore = stubFetch({ ok: false, error: 'invalid_auth' });
  try {
    const creds = { mode: 'app', org: 'default', app_token: 'xapp-X', bot_token: 'xoxb-BAD', bot_id: null, bot_user_id: null };
    const out = await ensureBotIdentity(creds);
    assert.equal(out, null);
  } finally { restore(); clear(); }
});

test('resolveCreds prefers a stored app credential over nothing', async () => {
  clear();
  const store = { getApp: async () => ({ org: 'acme', app_id: 'A1', bot_token: 'xoxb-S',
    app_token: 'xapp-S', bot_user_id: 'UB', bot_id: 'BB', team_name: 'Acme' }), listApps: async () => [] };
  const c = await resolveCreds(store);
  assert.equal(c.mode, 'app');
  assert.equal(c.org, 'acme');
  clear();
});

test('resolveCreds returns null rather than a broken app credential when bot identity cannot be verified', async () => {
  clear();
  const restore = stubFetch({ ok: false, error: 'invalid_auth' });
  try {
    const store = { getApp: async () => ({ org: 'acme', app_id: 'A1', bot_token: 'xoxb-BAD',
      app_token: 'xapp-BAD', bot_user_id: null, bot_id: null, team_name: null }), listApps: async () => [] };
    const c = await resolveCreds(store);
    assert.equal(c, null);
  } finally { restore(); clear(); }
});

test('resolveCreds falls back to user creds when no app creds exist', async () => {
  clear();
  process.env.SLACKLINE_XOXC = 'xoxc-U';
  process.env.SLACKLINE_XOXD = 'dcookie';
  process.env.SLACKLINE_USER = 'U1';   // pre-fill user_id so ensureUserId skips its real-network auth.test fallback
  const store = { getApp: async () => null, listApps: async () => [] };
  const c = await resolveCreds(store);
  assert.equal(c.mode, 'user');
  clear();
});

test('resolveCreds returns null when nothing is configured', async () => {
  clear();
  assert.equal(await resolveCreds({ getApp: async () => null, listApps: async () => [] }), null);
  clear();
});
