// channels delivery mode. This mode is advisory-only (see bridges/channels.mjs for why: the
// actual push lives in mcp.mjs, which bridge.mjs cannot reach into). UNTESTABLE end-to-end here
// because the installed Claude Code does not support --channels — these tests only cover the
// probe logic and the advisory init(), both of which are real code paths regardless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as channelsMode from '../bridges/channels.mjs';

test('available(): true when the installed claude --help lists --channels', async () => {
  const exec = (file, args, opts, cb) => cb(null, 'usage: claude [options]\n  --channels <spec>  ...\n', '');
  assert.equal(await channelsMode.available(exec), true);
});

// Help text alone is inconclusive: the flags are HIDDEN while the feature is in preview, so
// absence from --help must fall through to the binary scan rather than decide the answer.
test('available(): help without the flag falls back to scanning the binary', async () => {
  const seen = [];
  const exec = (file, args, opts, cb) => {
    seen.push(file);
    if (file === 'claude') return cb(null, 'usage: claude [options]\n  --print, -p  ...\n', '');
    return cb(null, '0\n', '');           // grep found nothing in the binary
  };
  assert.equal(await channelsMode.available(exec), false);
  assert.ok(seen.includes('sh'), 'must consult the binary, not trust --help alone');
});

test('available(): true when the binary contains the flag even though --help hides it', async () => {
  const exec = (file, args, opts, cb) => {
    if (file === 'claude') return cb(null, 'usage: claude [options]\n  --print, -p  ...\n', '');
    return cb(null, '3\n', '');           // grep found the literal flag
  };
  assert.equal(await channelsMode.available(exec), true);
});

test('available(): false when claude itself is not runnable', async () => {
  const exec = (file, args, opts, cb) => cb(new Error('command not found'));
  assert.equal(await channelsMode.available(exec), false);
});

test('init() is advisory only: no ingest to start, documents the real launch command', () => {
  const logs = [];
  const delivery = channelsMode.init({ log: (m) => logs.push(m) });

  assert.equal(delivery.skipIngest, true, 'bridge.mjs must not start a duplicate Socket Mode connection');
  assert.equal(delivery.deliver, undefined);
  assert.ok(logs.some(l => l.includes('SLACKLINE_CHANNEL=1')));
  // Must advise the DEVELOPMENT flag: plain --channels only accepts an Anthropic-allowlisted
  // plugin, and slackline is not on it — Claude Code starts fine and the channel never registers.
  assert.ok(logs.some(l => l.includes('--dangerously-load-development-channels server:slackline')));
  assert.ok(logs.some(l => /allowlist/i.test(l)), 'must explain why plain --channels fails');
});
