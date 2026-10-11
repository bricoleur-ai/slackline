import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeFor } from '../badge.mjs';

test('user mode prefixes a robot badge so humans can tell it is an agent', () => {
  assert.equal(badgeFor({ mode: 'user' }, 'hello', false), ':robot_face: hello');
});

test('app mode does not badge — the bot already has its own identity', () => {
  assert.equal(badgeFor({ mode: 'app' }, 'hello', false), 'hello');
});

test('no_badge suppresses the badge in user mode', () => {
  assert.equal(badgeFor({ mode: 'user' }, 'hello', true), 'hello');
});

test('an existing badge is not doubled', () => {
  assert.equal(badgeFor({ mode: 'user' }, ':robot_face: hi', false), ':robot_face: hi');
});
