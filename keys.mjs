// Scoped consumer keys — lets the hub grant a consumer machine access to only some of its
// Slack auth instances (orgs), instead of the single all-or-nothing SLACKLINE_SECRET. See
// docs/keys.md. This is the one place key material is generated, hashed, and verified; api.mjs
// and cli.mjs both call into it rather than touching crypto or the `keys` table directly, so
// there is exactly one place to audit for "does this ever log/return the raw key".
//
// SECURITY: only createKey() ever returns raw key material, and only once, at creation — by
// design the caller prints it and never sees it again. Every other function here returns at
// most {id, label, orgs, created, last_used, revoked} — never `hash`, never the key itself.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PREFIX = 'slk_';
const ID_BYTES = 6;       // 12 hex chars — public, appears in `key list` / `key revoke <id>`
const SECRET_BYTES = 24;  // 48 hex chars (192 bits) — the part that actually authenticates

function sha256hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

// Constant-time compare for anything supplied-vs-stored (a key hash, or SLACKLINE_SECRET
// itself). Length is checked first — timingSafeEqual throws on mismatched buffer lengths
// rather than returning false, and the length check itself leaks nothing since hash/secret
// lengths are fixed regardless of what an attacker supplies.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Generates one new key. `id` is public (short, used for `key list`/`key revoke`); the secret
// half is what actually has to stay confidential. `hash` is sha256(full key) — see docs/keys.md
// for why a plain fast hash is fine here: the input is a 192-bit random token, not a
// human-guessable password, so there's nothing a slow KDF would buy against a stolen-DB
// attacker that brute-force infeasibility doesn't already provide.
export function generateKey() {
  const id = randomBytes(ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const key = `${PREFIX}${id}_${secret}`;
  return { id, key, hash: sha256hex(key) };
}

const KEY_RE = new RegExp(`^${PREFIX}([0-9a-f]{${ID_BYTES * 2}})_[0-9a-f]{${SECRET_BYTES * 2}}$`);
export function parseKeyId(key) { const m = KEY_RE.exec(key || ''); return m ? m[1] : null; }

// Storage format for the `orgs` column: '*' (wildcard) or a comma-joined, deduped list of org
// names — plain text, no JSON, because org names are simple slugs and this needs to stay
// something an operator can read straight out of `key list` or a DB browser.
export function normalizeOrgs(input) {
  if (input === '*') return '*';
  const arr = Array.isArray(input) ? input : String(input ?? '').split(',');
  const list = [...new Set(arr.map(s => String(s).trim()).filter(Boolean))];
  if (list.includes('*')) return '*';
  if (!list.length) throw new Error("orgs must be '*' or a non-empty list of org names");
  return list.join(',');
}
function parseOrgsField(stored) { return stored === '*' ? '*' : String(stored || '').split(',').filter(Boolean); }

// Does this key's scope cover `org`? '*' (master credential, or a wildcard key) always does.
// A null/empty org — nothing resolved yet, e.g. a multi-org hub queried with no ?org= — is left
// to the route's own "unknown org" handling rather than rejected here; there is nothing
// concrete to scope-check yet, and every route that resolves a real org still runs this check
// once it has one.
export function scopeAllows(scope, org) {
  if (scope === '*') return true;
  if (!org) return true;
  return Array.isArray(scope) && scope.includes(org);
}

// ---- hub side: create / list / revoke, all against the `keys` table every store backend
// implements (putKey/getKey/listKeys/touchKey/revokeKey — see stores/*.mjs) ------------------

export async function createKey(store, { label, orgs }) {
  const { id, key, hash } = generateKey();
  const orgsField = normalizeOrgs(orgs);
  const created = Date.now();
  await store.putKey({ id, hash, label: label || '', orgs: orgsField, created, last_used: null, revoked: false });
  return { id, key, label: label || '', orgs: orgsField, created };   // `key` is shown ONCE by the caller
}

export async function listKeys(store) {
  const rows = await store.listKeys();
  // Explicit allowlist, never `...row` — see file header. A future column added to the table
  // (or to store.listKeys()'s SELECT *) can't leak through this by accident.
  return rows.map(r => ({ id: r.id, label: r.label, orgs: r.orgs, created: r.created, last_used: r.last_used, revoked: !!r.revoked }));
}

export async function revokeKey(store, id) { return !!(await store.revokeKey(id)); }

// Verifies a presented key against the store; returns {id, label, orgs} (orgs already parsed to
// '*' or an array, ready for scopeAllows) or null for anything invalid — unknown id, revoked, or
// hash mismatch all collapse to the same null so a caller can't distinguish "no such key" from
// "wrong secret half" (api.mjs turns null into a flat 401 either way). On success, stamps
// last_used so `key list` lets the operator spot a key nobody's using.
export async function verifyKey(store, presented) {
  const id = parseKeyId(presented);
  if (!id) return null;
  const row = await store.getKey(id);
  if (!row || row.revoked) return null;
  if (!safeEqual(sha256hex(presented), row.hash)) return null;
  try { await store.touchKey(id); } catch {}   // best-effort bookkeeping; never fail auth over it
  return { id: row.id, label: row.label, orgs: parseOrgsField(row.orgs) };
}

// ---- consumer side: ~/.slackline/config.json = { "hub": "...", "key": "slk_..." }. Mirrors
// envfile.mjs's loadEnvFile (same homedir()-relative default path, same "missing file -> no
// config, not an error" contract) but for a consumer's JSON file, not the hub's bridge.env —
// deliberately not merged with that file since the two live on different machines for different
// audiences.
export function loadConsumerConfig(filePath = path.join(homedir(), '.slackline', 'config.json')) {
  if (!existsSync(filePath)) return null;
  try {
    const mode = statSync(filePath).mode & 0o777;
    if (mode !== 0o600) console.error(`warning: ${filePath} is not mode 0600 (it holds a slackline key) — run: chmod 600 ${filePath}`);
  } catch {}
  const cfg = JSON.parse(readFileSync(filePath, 'utf8'));
  return { hub: cfg.hub ?? null, key: cfg.key ?? null };
}
