// Slack push for OpenCode. Runs inside the OpenCode process (see plugin.mjs): it holds the hub
// streams for the instance's directory and injects each message into a session as a prompt.
//
// WHICH SESSION: the root session (no parentID) that most recently showed activity in this
// instance. Subagent sessions are never targeted — a Slack message dropped into a subagent's
// context would derail a task the operator never sees. A message that arrives before any root
// session exists is held (up to HOLD_MAX) until one does.
//
// Delivery is at most once (docs/agents.md, "What push does and does not do"): a rejected prompt is logged and dropped.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { remoteConfig } from '../../remote.mjs';
import { resolve as resolveRoute } from '../route.mjs';
import { envelope } from '../envelope.mjs';
import { openStreams } from '../streams.mjs';

export const HOLD_MAX = 50;

// A plugin shares the TUI's terminal, so it must never write to stdout/stderr. Log to a file.
export function fileLog(home = homedir()) {
  const dir = `${home}/.slackline/logs`;
  return (msg) => {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); appendFileSync(`${dir}/opencode.log`, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 }); } catch {}
  };
}

export function createPush({ client, directory, cfg = remoteConfig(), streams = resolveRoute(directory), open = openStreams, log = () => {} }) {
  let current = null, handle = null, busy = Promise.resolve();
  const held = [];                 // { id, text } waiting for a root session
  const root = new Map();          // session id -> is it a root session?

  // Sessions created while we are loaded tell us their parentID in the event. One resumed from
  // before (`opencode -c`) does not, so it is looked up — once.
  async function isRoot(id) {
    if (root.has(id)) return root.get(id);
    let r = false;
    try { const res = await client.session.get({ path: { id } }); const s = res && (res.data || res); r = !!s && !!s.id && !s.parentID; } catch {}
    root.set(id, r);
    return r;
  }

  function flush() {
    busy = busy.then(async () => {
      while (current && held.length) {
        const m = held.shift();                                      // shift first: at most once
        try {
          const res = await client.session.promptAsync({ path: { id: current }, body: { parts: [{ type: 'text', text: m.text }] } });
          if (res && res.error) throw new Error(typeof res.error === 'string' ? res.error : (res.error.name || JSON.stringify(res.error)));
          log(`delivered ${m.id} to ${current}`);
        } catch (e) { log(`promptAsync failed for ${m.id}: ${String(e.message).slice(0, 200)}`); }
      }
    });
    return busy;
  }

  async function active(id) { if (id && await isRoot(id)) { current = id; await flush(); } }

  async function event({ event: e }) {
    if (!e) return;
    const p = e.properties || {};
    switch (e.type) {
      case 'session.created': case 'session.updated':
        if (p.info && p.info.id) { root.set(p.info.id, !p.info.parentID); await active(p.info.id); }
        break;
      case 'session.deleted':
        if (p.info && p.info.id) { root.delete(p.info.id); if (p.info.id === current) current = null; }
        break;
      case 'session.idle': case 'session.status': await active(p.sessionID); break;
      case 'message.updated': await active(p.info && p.info.sessionID); break;
    }
  }

  function start() {
    if (!cfg) { log('no hub configured (~/.slackline/config.json) — push is off'); return; }
    if (!streams.length) { log(`nothing routed for ${directory} — push is off`); return; }
    handle = open({ cfg, streams, log, onRow: (row, org) => {
      held.push({ id: `${org}/${row.channel}/${row.ts}`, text: envelope(row, org) });
      while (held.length > HOLD_MAX) held.shift();
      flush();
    } });
    log(`listening for ${streams.map(s => `${s.org}:${s.channels.join(',')}`).join(' ')} in ${directory}`);
  }

  return { event, start, stop() { if (handle) handle.stop(); }, idle: () => busy,
    get current() { return current; }, get held() { return held.length; } };
}
