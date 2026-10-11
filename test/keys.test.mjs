import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  generateKey, parseKeyId, safeEqual, normalizeOrgs, scopeAllows,
  createKey, listKeys, revokeKey, verifyKey, loadConsumerConfig,
} from '../keys.mjs';
import { MemoryStore } from '../stores/memory.mjs';

// ---- generateKey / parseKeyId --------------------------------------------------------------

test('generateKey produces a slk_<id>_<secret> key and a sha256 hash of the full key', async () => {
  const { createHash } = await import('node:crypto');
  const { id, key, hash } = generateKey();
  assert.match(key, /^slk_[0-9a-f]{12}_[0-9a-f]{48}$/);
  assert.equal(id, key.slice(4, 16));
  assert.equal(hash, createHash('sha256').update(key, 'utf8').digest('hex'));
  assert.equal(hash.length, 64);
});

test('generateKey never repeats — two calls differ in id, secret half, and hash', () => {
  const a = generateKey(), b = generateKey();
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.hash, b.hash);
});

test('parseKeyId extracts the id from a well-formed key, null for anything else', () => {
  const { id, key } = generateKey();
  assert.equal(parseKeyId(key), id);
  for (const bad of ['', null, undefined, 'slk_', 'slk_notenoughhex', 'nope_' + key.slice(4), key + 'x', 'slk_' + 'a'.repeat(12) + '_' + 'b'.repeat(47)]) {
    assert.equal(parseKeyId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---- safeEqual (timing-safe compare) -------------------------------------------------------

test('safeEqual: true only for identical strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);   // different length must not throw
  assert.equal(safeEqual('', ''), true);
});
test('safeEqual: non-string inputs are always false, never throw', () => {
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual(123, '123'), false);
});

// ---- normalizeOrgs / scopeAllows ------------------------------------------------------------

test('normalizeOrgs: wildcard passes through, lists are trimmed/deduped/comma-joined', () => {
  assert.equal(normalizeOrgs('*'), '*');
  assert.equal(normalizeOrgs('globex'), 'globex');
  assert.equal(normalizeOrgs('globex, acme , globex'), 'globex,acme');
  assert.equal(normalizeOrgs(['globex', 'acme']), 'globex,acme');
  assert.equal(normalizeOrgs(['*', 'globex']), '*');   // a wildcard anywhere in the list wins
});
test('normalizeOrgs: rejects an empty scope rather than silently granting nothing useful', () => {
  assert.throws(() => normalizeOrgs(''));
  assert.throws(() => normalizeOrgs('   ,  ,'));
  assert.throws(() => normalizeOrgs([]));
});

test('scopeAllows: wildcard scope allows any org', () => {
  assert.equal(scopeAllows('*', 'acme'), true);
  assert.equal(scopeAllows('*', null), true);
});
test('scopeAllows: list scope only allows listed orgs', () => {
  assert.equal(scopeAllows(['globex'], 'globex'), true);
  assert.equal(scopeAllows(['globex'], 'acme'), false);
  assert.equal(scopeAllows([], 'anything'), false);
});
test('scopeAllows: a null/empty org is let through — nothing concrete to reject yet', () => {
  assert.equal(scopeAllows(['globex'], null), true);
  assert.equal(scopeAllows(['globex'], ''), true);
});

// ---- createKey / listKeys / revokeKey / verifyKey, against a real store ---------------------

async function freshStore() { const s = new MemoryStore(); await s.init(); return s; }

test('createKey returns the raw key once; listKeys never includes it or the hash', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex' });
  assert.match(created.key, /^slk_/);
  assert.equal(created.orgs, 'globex');

  const rows = await listKeys(store);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, created.id);
  assert.equal(row.label, 'laptop agent');
  assert.equal(row.orgs, 'globex');
  assert.equal(row.revoked, false);
  assert.equal(row.last_used, null);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'hash'), false, 'listKeys must never surface the hash');
  assert.equal(JSON.stringify(rows).includes(created.key), false, 'listKeys must never surface the raw key');
});

test('verifyKey accepts a freshly created key and reports its parsed scope', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'admin', orgs: '*' });
  const verified = await verifyKey(store, created.key);
  assert.ok(verified);
  assert.equal(verified.id, created.id);
  assert.equal(verified.orgs, '*');
  assert.equal(Object.prototype.hasOwnProperty.call(verified, 'hash'), false);
});

test('verifyKey parses a scoped orgs field into an array', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'laptop agent', orgs: 'globex,acme' });
  const verified = await verifyKey(store, created.key);
  assert.deepEqual(verified.orgs, ['globex', 'acme']);
});

test('verifyKey returns null for an unknown key, a malformed key, and undefined', async () => {
  const store = await freshStore();
  await createKey(store, { label: 'x', orgs: '*' });
  const { key: neverStored } = generateKey();
  assert.equal(await verifyKey(store, neverStored), null);
  assert.equal(await verifyKey(store, 'not-even-the-right-shape'), null);
  assert.equal(await verifyKey(store, undefined), null);
});

test('verifyKey rejects a key whose id is real but whose secret half was tampered with', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'x', orgs: '*' });
  const tampered = created.key.slice(0, -1) + (created.key.at(-1) === '0' ? '1' : '0');
  assert.equal(await verifyKey(store, tampered), null);
});

test('revokeKey makes verifyKey reject the key from then on; listKeys still shows it as revoked', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'x', orgs: 'globex' });
  assert.ok(await verifyKey(store, created.key));
  assert.equal(await revokeKey(store, created.id), true);
  assert.equal(await verifyKey(store, created.key), null);
  const row = (await listKeys(store)).find(r => r.id === created.id);
  assert.equal(row.revoked, true);
});

test('revokeKey on an unknown id returns false rather than throwing', async () => {
  const store = await freshStore();
  assert.equal(await revokeKey(store, 'nonexistent0'), false);
});

test('verifyKey stamps last_used on a successful check (so `key list` can show a stale key)', async () => {
  const store = await freshStore();
  const created = await createKey(store, { label: 'x', orgs: '*' });
  assert.equal((await store.getKey(created.id)).last_used, null);
  await verifyKey(store, created.key);
  assert.ok(typeof (await store.getKey(created.id)).last_used === 'number');
});

// ---- loadConsumerConfig ----------------------------------------------------------------------

function tmpConfigDir() { return mkdtempSync(path.join(tmpdir(), 'slackline-config-test-')); }

test('loadConsumerConfig returns null when the file does not exist (no throw)', () => {
  const dir = tmpConfigDir();
  assert.equal(loadConsumerConfig(path.join(dir, 'nope.json')), null);
});

test('loadConsumerConfig reads hub/key from a 0600 file without warning', () => {
  const dir = tmpConfigDir();
  const fp = path.join(dir, 'config.json');
  writeFileSync(fp, JSON.stringify({ hub: 'http://hub.example.com:8790', key: 'slk_abc' }));
  chmodSync(fp, 0o600);
  const origError = console.error;
  const warnings = [];
  console.error = (...a) => warnings.push(a.join(' '));
  try {
    const cfg = loadConsumerConfig(fp);
    assert.deepEqual(cfg, { hub: 'http://hub.example.com:8790', key: 'slk_abc' });
    assert.equal(warnings.length, 0);
  } finally { console.error = origError; }
});

test('loadConsumerConfig warns (but still loads) when the file is not mode 0600', () => {
  const dir = tmpConfigDir();
  const fp = path.join(dir, 'config.json');
  writeFileSync(fp, JSON.stringify({ hub: 'http://hub.example.com:8790', key: 'slk_abc' }));
  chmodSync(fp, 0o644);
  const origError = console.error;
  const warnings = [];
  console.error = (...a) => warnings.push(a.join(' '));
  try {
    const cfg = loadConsumerConfig(fp);
    assert.deepEqual(cfg, { hub: 'http://hub.example.com:8790', key: 'slk_abc' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /0600/);
    assert.equal(warnings[0].includes('slk_abc'), false, 'warning must never echo the key itself');
  } finally { console.error = origError; }
});
