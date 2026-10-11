// Migration orchestration on top of the exportTable/importRows pair every store in stores/
// implements (see the "migration" section at the bottom of each). Deliberately store-instance
// based, not spec-string based — this file never calls createStore/imports db.mjs, so cli.mjs
// owns opening stores from --from/--to/env and this file stays trivially unit-testable with
// plain in-process store instances (see test/migrate*.test.mjs).
//
// Idempotency: every function here is safe to run twice. exportToFile/copyStores just replay
// exportTable -> importRows, and every store's importRows is an upsert keyed on that table's
// natural primary key (see stores/*.mjs) — re-running never duplicates a row. importFromFile is
// the same, replayed from a file instead of a live source store.
//
// Credentials: tokens/apps carry the Slack session token/cookie and xapp-/xoxb- bot tokens.
// This file never logs, prints, or returns a raw value from either table — verifyStores below
// compares them by sha256 hash + length only (see hashOf), and every other function here only
// ever returns row *counts*, never row contents.
import { createHash } from 'node:crypto';
import { openSync, createWriteStream, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const TABLES = ['tokens', 'apps', 'users', 'channels', 'messages', 'threads', 'outbound'];
const BATCH = 500;   // rows buffered per table before an ndjson import flushes to the store

export function resolveTables(requested) {
  if (!requested || !requested.length) return TABLES.slice();
  const bad = requested.filter(t => !TABLES.includes(t));
  if (bad.length) throw new Error(`migrate: unknown table(s): ${bad.join(', ')} (known: ${TABLES.join(', ')})`);
  return requested;
}

// ---- export/import against an ndjson file: one JSON object per line, {table, row} — plus a
// leading {__meta__:true, ...} line for provenance. import tolerates unknown/missing meta and
// skips blank/corrupt lines, so a hand-trimmed or concatenated file still loads.

export async function exportToFile(store, { out, tables, dryRun } = {}) {
  const list = resolveTables(tables);
  const counts = {};
  if (dryRun) {
    for (const table of list) { let n = 0; for await (const _ of store.exportTable(table)) n++; counts[table] = n; }
    return { out, tables: counts, dryRun: true };
  }
  // Open with mode 0600 up front (not chmod after) so the file is never briefly world/group
  // readable — tokens/apps rows in here are a live Slack session token + xoxb-/xapp- bot creds.
  const fd = openSync(out, 'w', 0o600);
  const ws = createWriteStream(null, { fd });
  let streamError = null;
  ws.on('error', (e) => { streamError = e; });
  const write = (obj) => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    const ok = ws.write(JSON.stringify(obj) + '\n');
    if (ok) resolve(); else ws.once('drain', resolve);
  });
  try {
    await write({ __meta__: true, exportedAt: new Date().toISOString(), tables: list });
    for (const table of list) {
      let n = 0;
      for await (const row of store.exportTable(table)) { await write({ table, row }); n++; }
      if (streamError) throw streamError;
      counts[table] = n;
    }
    if (streamError) throw streamError;
  } finally {
    await new Promise((resolve) => ws.end(resolve));
  }
  return { out, tables: counts, dryRun: false };
}

export async function importFromFile(store, { in: inPath, tables, dryRun } = {}) {
  const allow = tables && tables.length ? new Set(resolveTables(tables)) : null;
  const rl = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity });
  // Batches are per-table and capped at BATCH before a flush — bounds memory to (distinct
  // tables in the file) * BATCH rows regardless of how large the file or any one table is,
  // even if rows for different tables happen to be interleaved on disk.
  const batches = new Map();
  const counts = {};
  const flush = async (table) => {
    const batch = batches.get(table);
    if (!batch || !batch.length) return;
    if (!dryRun) await store.importRows(table, batch);
    counts[table] = (counts[table] || 0) + batch.length;
    batches.set(table, []);
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }   // tolerate a stray blank/corrupt trailing line
    if (!obj || obj.__meta__ || !obj.table || !('row' in obj)) continue;
    if (allow && !allow.has(obj.table)) continue;
    if (!batches.has(obj.table)) batches.set(obj.table, []);
    batches.get(obj.table).push(obj.row);
    if (batches.get(obj.table).length >= BATCH) await flush(obj.table);
  }
  for (const table of batches.keys()) await flush(table);
  return { in: inPath, tables: counts, dryRun: !!dryRun };
}

// ---- direct store-to-store copy, no intermediate file. dst.importRows consumes
// src.exportTable's generator directly, so nothing here buffers a whole table — each store's
// importRows does its own internal batching (see stores/*.mjs).
export async function copyStores(src, dst, { tables, dryRun } = {}) {
  const list = resolveTables(tables);
  const counts = {};
  for (const table of list) {
    if (dryRun) { let n = 0; for await (const _ of src.exportTable(table)) n++; counts[table] = n; continue; }
    counts[table] = await dst.importRows(table, src.exportTable(table));
  }
  return { tables: counts, dryRun: !!dryRun };
}

// sha256 hex digest + plaintext length, e.g. "a1b2c3...:42" — lets verifyStores confirm a
// credential round-tripped byte-for-byte without ever holding or returning the value itself.
function hashOf(v) { return v == null ? null : `${createHash('sha256').update(String(v)).digest('hex')}:${String(v).length}`; }
const CRED_FIELDS = { tokens: ['token', 'cookie'], apps: ['bot_token', 'app_token'] };

// ---- row-count drift per table, plus (for tokens/apps specifically) a per-org hash comparison
// of every credential field. tokens/apps are always small (one row per connected org), so
// indexing them by org while streaming is fine even though messages/users/channels/etc. are
// deliberately left as a plain streaming count (never indexed) to honor the "don't load a whole
// workspace into memory" constraint for the tables that can actually be large.
export async function verifyStores(src, dst, { tables } = {}) {
  const list = resolveTables(tables);
  const result = { tables: {}, ok: true };
  for (const table of list) {
    const credFields = CRED_FIELDS[table];
    if (!credFields) {
      let from = 0; for await (const _ of src.exportTable(table)) from++;
      let to = 0; for await (const _ of dst.exportTable(table)) to++;
      const drift = from - to;
      result.tables[table] = { from, to, drift };
      if (drift !== 0) result.ok = false;
      continue;
    }
    const srcIdx = new Map();
    let from = 0;
    for await (const row of src.exportTable(table)) { from++; srcIdx.set(row.org, row); }
    let to = 0;
    const credentials = {};
    for await (const row of dst.exportTable(table)) {
      to++;
      const s = srcIdx.get(row.org);
      const check = {};
      for (const f of credFields) check[f] = !s ? 'missing-from-source' : (hashOf(s[f]) === hashOf(row[f]) ? 'match' : 'mismatch');
      credentials[row.org] = check;
    }
    for (const org of srcIdx.keys()) if (!credentials[org]) credentials[org] = Object.fromEntries(credFields.map(f => [f, 'missing-from-dest']));
    const drift = from - to;
    const credOk = Object.values(credentials).every(c => Object.values(c).every(v => v === 'match'));
    result.tables[table] = { from, to, drift, credentials };
    if (drift !== 0 || !credOk) result.ok = false;
  }
  return result;
}
