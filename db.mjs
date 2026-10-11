// Storage factory. Pick a backend with SLACKLINE_STORE (or DATABASE_URL for postgres):
//   memory                     ephemeral, zero deps
//   sqlite  | sqlite:/path.db   file-backed (default ~/.slackline/slackline.db, or under SLACKLINE_STATE_DIR), no native deps
//   postgres | postgres://...   scale-out (multi-process split; NOTIFY fan-out)
import { defaultDbPath } from './paths.mjs';
import { PostgresStore } from './stores/postgres.mjs';
import { SqliteStore } from './stores/sqlite.mjs';
import { MemoryStore } from './stores/memory.mjs';

export function createStore(spec) {
  let s = spec || process.env.SLACKLINE_STORE || (process.env.DATABASE_URL ? process.env.DATABASE_URL : 'sqlite');
  if (s === 'memory') return new MemoryStore();
  if (s === 'postgres' || s.startsWith('postgres://')) {
    const url = s.startsWith('postgres://') ? s : (process.env.DATABASE_URL || (() => {
  throw new Error(
    'DATABASE_URL is not set. Either set it (postgres://user:pass@host:5432/db), ' +
    'or use the bundled SQLite store with SLACKLINE_STORE=sqlite, which needs no server.'
  );
})());
    return new PostgresStore(url);
  }
  if (s === 'sqlite' || s.startsWith('sqlite')) {
    const path = s.includes(':') ? s.slice(s.indexOf(':') + 1) : defaultDbPath();
    return new SqliteStore(path);
  }
  return new SqliteStore(s);            // treat anything else as a sqlite path
}
export function backendName(spec) {
  let s = spec || process.env.SLACKLINE_STORE || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
  return s.startsWith('postgres') ? 'postgres' : s.startsWith('sqlite') ? 'sqlite' : s;
}
