import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect } from '../transports/rtm.mjs';

// Deprecation-signal warning logic added to transports/rtm.mjs. This is purely additive:
// it must never change the non-fatal retry contract (see transport-rtm.test.mjs), only add a
// diagnostic log line when a failure pattern looks like Slack withdrawing rtm.connect access
// for user session tokens, rather than routine token rotation.
//
// A fresh `org` per test is required: the warning state (streak/cooldown) is module-level,
// keyed by org, so tests must not share a key or they'd interfere with each other's counts.

const SECRET_TOKEN = 'xoxc-should-never-appear-in-a-log-1234567890';
const SECRET_COOKIE = 'd-cookie-should-never-appear-in-a-log-abcdef';

function credsFor(org) {
  return { mode: 'user', token: SECRET_TOKEN, cookie: SECRET_COOKIE, org };
}

// Drives one rtm.connect() attempt that fails with `error`, collecting every log() call made
// during that attempt (there can be more than one: the ws-level handlers also log).
function failOnce(org, error, logs) {
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, error }) });
  return new Promise((resolve) => {
    connect({
      creds: credsFor(org),
      onEvent: () => {},
      onClose: (err, fatal) => resolve({ err, fatal }),
      log: (msg) => logs.push(msg),
    });
  });
}

class FakeWebSocket extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; }
  close() {}
}

// Drives one rtm.connect() attempt that succeeds (ws never has to actually open — a successful
// rtm.connect response is itself the signal the endpoint/token-type still works).
function succeedOnce(org, logs) {
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, url: 'wss://example.test/rtm' }) });
  const handle = connect({
    creds: credsFor(org),
    onEvent: () => {},
    onClose: () => {},
    log: (msg) => logs.push(msg),
    WebSocketImpl: FakeWebSocket,
  });
  return new Promise((resolve) => setImmediate(() => { handle.close(); resolve(); }));
}

test('a strong-signal error (not_allowed_token_type) warns immediately, still non-fatal', async () => {
  const logs = [];
  const closed = await failOnce('org-strong-1', 'not_allowed_token_type', logs);
  assert.notEqual(closed.fatal, true, 'warning logic must not change the non-fatal retry contract');
  const warning = logs.find(l => l.includes('WARNING'));
  assert.ok(warning, 'expected a deprecation warning on the first not_allowed_token_type failure');
  assert.match(warning, /not_allowed_token_type/);
  assert.match(warning, /docs\/rtm-deprecation\.md/);
  assert.match(warning, /app mode/);
});

test('deprecated_endpoint and method_deprecated are also treated as strong signals', async () => {
  for (const error of ['deprecated_endpoint', 'method_deprecated']) {
    const logs = [];
    await failOnce(`org-strong-${error}`, error, logs);
    assert.ok(logs.some(l => l.includes('WARNING')), `expected an immediate warning for ${error}`);
  }
});

test('an ambiguous error (invalid_auth) does not warn until it is persistent', async () => {
  const org = 'org-ambiguous-1';
  const logs = [];
  // Four consecutive failures: session-token rotation looks exactly like this and recovers,
  // so nothing should fire yet.
  for (let i = 0; i < 4; i++) await failOnce(org, 'invalid_auth', logs);
  assert.equal(logs.some(l => l.includes('WARNING')), false,
    'a handful of invalid_auth failures must not warn — that is indistinguishable from normal token rotation');
  // The 5th consecutive failure crosses the persistence threshold.
  await failOnce(org, 'invalid_auth', logs);
  const warning = logs.find(l => l.includes('WARNING'));
  assert.ok(warning, 'expected a warning once invalid_auth persists across several consecutive attempts');
  assert.match(warning, /invalid_auth/);
  assert.match(warning, /docs\/rtm-deprecation\.md/);
});

test('a successful rtm.connect resets the persistence streak', async () => {
  const org = 'org-reset-1';
  const logs = [];
  for (let i = 0; i < 4; i++) await failOnce(org, 'invalid_auth', logs);
  await succeedOnce(org, logs);              // the grant still works — this is not a withdrawal
  for (let i = 0; i < 4; i++) await failOnce(org, 'invalid_auth', logs);
  assert.equal(logs.some(l => l.includes('WARNING')), false,
    'a success in between should reset the streak, so 4+4 failures must not cross the threshold');
});

test('a repeated strong signal is not re-announced inside the cooldown window', async () => {
  const org = 'org-cooldown-1';
  const logs = [];
  await failOnce(org, 'not_allowed_token_type', logs);
  await failOnce(org, 'not_allowed_token_type', logs);
  await failOnce(org, 'not_allowed_token_type', logs);
  const warnings = logs.filter(l => l.includes('WARNING'));
  assert.equal(warnings.length, 1, 'repeated failures within the cooldown window must log only once, not spam');
});

test('no log line ever contains the raw token or cookie value', async () => {
  const org = 'org-no-leak-1';
  const logs = [];
  await failOnce(org, 'not_allowed_token_type', logs);
  await failOnce(org, 'invalid_auth', logs);
  await succeedOnce(org, logs);
  for (const line of logs) {
    assert.doesNotMatch(line, new RegExp(SECRET_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(line, new RegExp(SECRET_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
