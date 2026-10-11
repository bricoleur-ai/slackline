// bridges/core.mjs's saveFiles() downloads Slack attachments so the receiving agent gets real
// local paths (screenshots, for visual QA). Every message through the live bridge so far has
// been text-only, so this download path has never actually run. saveFiles is a pure exported
// function (no top-level side effects on import, unlike bridge.mjs itself, which opens a real
// Slack connection at module load) — stub fetch and exercise it directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { saveFiles } from '../bridges/core.mjs';

const creds = { mode: 'app', bot_token: 'xoxb-fake' };
const noop = () => {};

function stubFetch(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = real; };
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'slackline-savefiles-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('saveFiles: a successful download writes the file and returns its path', () => withTmpDir(async (dir) => {
  const body = 'screenshot-bytes';
  const restore = stubFetch(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }));
  try {
    const out = await saveFiles(creds, [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', url: 'https://files.slack.com/F1' }], dir, noop);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'shot.png');
    assert.equal(out[0].mimetype, 'image/png');
    assert.ok(existsSync(out[0].path));
    assert.equal(readFileSync(out[0].path, 'utf8'), body);
  } finally { restore(); }
}));

test('saveFiles: a non-OK HTTP response is skipped without throwing', () => withTmpDir(async (dir) => {
  let called = 0;
  const restore = stubFetch(async () => { called++; return { ok: false, status: 404 }; });
  try {
    // Calling it directly (rather than wrapping in assert.doesNotReject, which discards the
    // resolved value) is itself the "does not throw" assertion: an unhandled rejection here
    // would fail the test.
    const out = await saveFiles(creds, [{ id: 'F2', name: 'gone.png', url: 'https://files.slack.com/F2' }], dir, noop);
    assert.deepEqual(out, []);
    assert.equal(called, 1);
    assert.deepEqual(readdirSync(dir), []);   // nothing partially written
  } finally { restore(); }
}));

test('saveFiles: a file with no url is skipped (fetch never called)', () => withTmpDir(async (dir) => {
  let called = 0;
  const restore = stubFetch(async () => { called++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; });
  try {
    const out = await saveFiles(creds, [{ id: 'F3', name: 'no-url.png' }], dir, noop);
    assert.deepEqual(out, []);
    assert.equal(called, 0);
  } finally { restore(); }
}));

test('saveFiles: a path-traversal filename cannot escape the target directory', () => withTmpDir(async (dir) => {
  const body = 'payload';
  const restore = stubFetch(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }));
  try {
    const out = await saveFiles(creds,
      [{ id: 'F4', name: '../../../../etc/passwd', url: 'https://files.slack.com/F4' }], dir, noop);
    assert.equal(out.length, 1);
    // The written file must resolve to strictly inside `dir` — no path separator survives
    // sanitization, so "../" cannot act as a directory traversal (it becomes literal "..-"-ish
    // characters in a single filename, not a parent-directory reference).
    const real = resolve(out[0].path);
    assert.ok(real === dir || real.startsWith(dir + sep), `escaped target dir: ${real}`);
    // Exactly one file landed, and it's a regular file directly inside dir (not a directory
    // dive) — the traversal input produced an inert filename, not a path.
    assert.deepEqual(readdirSync(dir), [out[0].path.slice(dir.length + 1)]);
  } finally { restore(); }
}));

test('saveFiles: shell metacharacters in the filename are stripped, not passed through', () => withTmpDir(async (dir) => {
  const body = 'payload';
  const restore = stubFetch(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }));
  try {
    const out = await saveFiles(creds,
      [{ id: 'F5', name: '$(rm -rf ~)`whoami`; evil.png', url: 'https://files.slack.com/F5' }], dir, noop);
    assert.equal(out.length, 1);
    const written = readdirSync(dir)[0];
    assert.ok(!/[$`;()~\s]/.test(written), `unsafe characters survived sanitization: ${written}`);
    const real = resolve(out[0].path);
    assert.ok(real === dir || real.startsWith(dir + sep));
  } finally { restore(); }
}));

test('saveFiles: one failing file does not block a later successful one', () => withTmpDir(async (dir) => {
  let n = 0;
  const restore = stubFetch(async () => {
    n++;
    if (n === 1) return { ok: false, status: 500 };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('ok').buffer };
  });
  try {
    const out = await saveFiles(creds, [
      { id: 'F6', name: 'first-fails.png', url: 'https://files.slack.com/F6' },
      { id: 'F7', name: 'second-ok.png', url: 'https://files.slack.com/F7' },
    ], dir, noop);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'second-ok.png');
  } finally { restore(); }
}));
