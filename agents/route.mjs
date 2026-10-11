#!/usr/bin/env node
// Directory-based routing: which Slack channels a session started in a given directory
// listens to. One table per machine (~/.slackline/routes.json), one resolver, used by every
// agent adapter — see docs/agents.md.
//
//   { "defaults": [ { "org": "acme", "channels": ["D0…"] } ],
//     "routes":   [ { "dir": "/abs/path", "org": "acme", "channels": ["C0…"] } ] }
//
// Every entry names its workspace (org) because the hub's /tail stream is per workspace.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function routesPath(env = process.env) {
  return env.SLACKLINE_ROUTES_FILE || `${homedir()}/.slackline/routes.json`;
}

// Absent, malformed or wrongly shaped is "no routes", never an error: a session must still
// start with its tools when someone has left a typo in this file.
export function loadRoutes(file = routesPath()) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return { defaults: [], routes: [] }; }
  const clean = (list, needDir) => (Array.isArray(list) ? list : [])
    .filter(e => e && typeof e.org === 'string' && e.org && Array.isArray(e.channels)
      && (!needDir || (typeof e.dir === 'string' && e.dir.startsWith('/'))))
    .map(e => ({ ...(needDir ? { dir: e.dir } : {}), org: e.org,
      channels: e.channels.filter(c => typeof c === 'string' && c) }));
  return { defaults: clean(j && j.defaults, false), routes: clean(j && j.routes, true) };
}

// Real paths, so a symlinked checkout and a trailing slash both compare equal.
function real(p) { try { return realpathSync(p); } catch { return resolvePath(p); } }
// Separator boundary: /a/foo must never match /a/foobar.
const within = (dir, root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

// Defaults plus the nearest mapped directory (the session directory itself or its closest
// ancestor). Returns one entry per workspace; an empty array means "nothing to push".
export function resolve(dir, { file = routesPath() } = {}) {
  const { defaults, routes } = loadRoutes(file);
  const here = real(dir);
  let best = null;
  for (const r of routes) {
    const d = real(r.dir);
    if (within(here, d) && (!best || d.length > best.length)) best = d;
  }
  const picked = [...defaults, ...(best ? routes.filter(r => real(r.dir) === best) : [])];
  const byOrg = new Map();
  for (const e of picked) {
    if (!byOrg.has(e.org)) byOrg.set(e.org, new Set());
    for (const c of e.channels) byOrg.get(e.org).add(c);
  }
  return [...byOrg].map(([org, set]) => ({ org, channels: [...set] })).filter(s => s.channels.length);
}

// Which workspace a channel belongs to, looking at EVERY entry (not just this session's): a
// session can be asked to reply in a channel another directory is routed to.
export function orgForChannel(channel, { file = routesPath() } = {}) {
  const { defaults, routes } = loadRoutes(file);
  const hit = [...routes, ...defaults].find(e => e.channels.includes(channel));
  return hit ? hit.org : null;
}

export function sessionDir(env = process.env) { return env.SLACKLINE_SESSION_DIR || process.cwd(); }

// The three ways a remote-mode mcp.mjs can be told what to push (docs/agents.md). Returns the
// streams to open; `channels: []` means "every channel in that workspace".
//   SLACKLINE_CHANNEL_ONLY set  -> exactly that list, in the default workspace (unchanged)
//   SLACKLINE_ROUTES=1          -> the routing table; nothing routed means no stream at all
//   neither                     -> every channel in the default workspace (unchanged)
export function pushPlan(env, dir, { file = routesPath(env), defaultOrg = '' } = {}) {
  const only = (env.SLACKLINE_CHANNEL_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
  if (only.length) return [{ org: defaultOrg, channels: only }];
  if (env.SLACKLINE_ROUTES === '1') return resolve(dir, { file });
  return [{ org: defaultOrg, channels: [] }];
}

// `slackline route [dir]` / `node agents/route.mjs [--quiet] [dir]`. --quiet is for shell
// callers that only need a yes/no: no output, exit 1 when nothing resolves.
export function main(args = process.argv.slice(2), env = process.env) {
  const quiet = args.includes('--quiet');
  const dir = args.find(a => !a.startsWith('--')) || sessionDir(env);
  const streams = resolve(dir, { file: routesPath(env) });
  if (!quiet) console.log(JSON.stringify({ dir: resolvePath(dir), streams }, null, 2));
  return quiet && !streams.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) process.exitCode = main();
