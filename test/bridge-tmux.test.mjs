// tmux delivery mode. Uses a REAL, dedicated, throwaway tmux session created and destroyed by
// this test — never a real session: the test must not touch any tmux session
// it did not create. Skips cleanly if tmux isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as tmuxMode from '../bridges/tmux.mjs';

function tmuxAvailable() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const HAVE_TMUX = tmuxAvailable();
const SESSION = `slackline-bridge-test-${process.pid}`;

test('tmux mode', { skip: !HAVE_TMUX && 'tmux is not installed in this environment' }, async (t) => {
  execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24']);
  t.after(() => { try { execFileSync('tmux', ['kill-session', '-t', SESSION]); } catch {} });

  const savedEnv = process.env.SLACKLINE_BRIDGE_TMUX;
  t.after(() => { process.env.SLACKLINE_BRIDGE_TMUX = savedEnv; });

  await t.test('available() is false with no target session configured', async () => {
    delete process.env.SLACKLINE_BRIDGE_TMUX;
    assert.equal(await tmuxMode.available(), false);
  });

  await t.test('available() is false for a session that does not exist (real probe, not a guess)', async () => {
    process.env.SLACKLINE_BRIDGE_TMUX = 'no-such-session-xyz';
    assert.equal(await tmuxMode.available(), false);
  });

  await t.test('available() is true once the target session actually exists', async () => {
    process.env.SLACKLINE_BRIDGE_TMUX = SESSION;
    assert.equal(await tmuxMode.available(), true);
  });

  await t.test('init() fails fast when SLACKLINE_BRIDGE_TMUX is unset', () => {
    delete process.env.SLACKLINE_BRIDGE_TMUX;
    assert.throws(() => tmuxMode.init({ log: () => {} }), /SLACKLINE_BRIDGE_TMUX/);
  });

  await t.test('init() fails fast on a missing session rather than silently dropping reports', () => {
    process.env.SLACKLINE_BRIDGE_TMUX = 'no-such-session-xyz';
    assert.throws(() => tmuxMode.init({ log: () => {} }), /not found/);
  });

  await t.test('deliver() types the pointer line literally into the pane and presses Enter', async () => {
    process.env.SLACKLINE_BRIDGE_TMUX = SESSION;
    const logs = [];
    const delivery = tmuxMode.init({ log: (m) => logs.push(m) });
    assert.equal(delivery.label, `tmux:${SESSION}`);

    const marker = `probe-${Date.now()}`;
    delivery.deliver(`New Slack message — see report ${marker}`);

    const pane = execFileSync('tmux', ['capture-pane', '-t', SESSION, '-p']).toString();
    assert.ok(pane.includes(marker), 'pointer text must land literally in the pane');
  });
});
