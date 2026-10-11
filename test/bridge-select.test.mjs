// Mode selection (SLACKLINE_BRIDGE=channels|tmux|headless|auto). Uses fake mode objects so
// 'auto' detection order and fallback behavior can be pinned deterministically, independent of
// what's actually installed on the machine running the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMode } from '../bridges/select.mjs';

function mode(name, isAvailable) { return { name, available: async () => isAvailable }; }

test('an explicit known mode is returned directly, without probing availability', async () => {
  const modes = { tmux: mode('tmux', false) };   // available() would say no, but explicit choice wins
  const m = await selectMode('tmux', modes);
  assert.equal(m.name, 'tmux');
});

test('an unknown explicit mode throws with the valid options listed', async () => {
  await assert.rejects(() => selectMode('bogus', {}), /unknown SLACKLINE_BRIDGE mode 'bogus'.*channels\|tmux\|headless\|auto/);
});

test('default (unset) mode is channels', async () => {
  const modes = { channels: mode('channels', true) };
  const m = await selectMode(undefined, modes);
  assert.equal(m.name, 'channels');
});

test('mode names are case-insensitive', async () => {
  const modes = { headless: mode('headless', true) };
  const m = await selectMode('HEADLESS', modes);
  assert.equal(m.name, 'headless');
});

test('auto prefers channels when it is actually available', async () => {
  const modes = { channels: mode('channels', true), tmux: mode('tmux', true), headless: mode('headless', true) };
  const m = await selectMode('auto', modes);
  assert.equal(m.name, 'channels');
});

test('auto falls back to tmux when channels is unavailable', async () => {
  const modes = { channels: mode('channels', false), tmux: mode('tmux', true), headless: mode('headless', true) };
  const m = await selectMode('auto', modes);
  assert.equal(m.name, 'tmux');
});

test('auto falls back to headless when neither channels nor tmux is available', async () => {
  const modes = { channels: mode('channels', false), tmux: mode('tmux', false), headless: mode('headless', true) };
  const m = await selectMode('auto', modes);
  assert.equal(m.name, 'headless');
});

test('auto throws a clear error when nothing is available (no guessing a mode)', async () => {
  const modes = { channels: mode('channels', false), tmux: mode('tmux', false), headless: mode('headless', false) };
  await assert.rejects(() => selectMode('auto', modes), /no delivery mode available/);
});

test('auto treats a throwing available() as unavailable rather than crashing', async () => {
  const modes = {
    channels: { name: 'channels', available: async () => { throw new Error('boom'); } },
    tmux: mode('tmux', true),
    headless: mode('headless', true),
  };
  const m = await selectMode('auto', modes);
  assert.equal(m.name, 'tmux');
});
