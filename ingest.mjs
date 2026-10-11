import { makeNormalizer } from './normalize.mjs';
import * as rtm from './transports/rtm.mjs';
import * as socket from './transports/socket.mjs';

// App-token creds use Socket Mode; everything else (including creds with no mode,
// for backward compat with pre-app-mode user creds) uses the RTM transport.
export function pickTransport(creds) {
  return creds.mode === 'app' ? { name: 'socket', connect: socket.connect }
                              : { name: 'rtm', connect: rtm.connect };
}

// opts[key] wins (test injection, no env lookup needed); otherwise read envName as
// milliseconds, falling back to `def` when unset/blank/non-numeric.
function msSetting(opts, key, envName, def) {
  if (opts[key] !== undefined) return opts[key];
  const v = process.env[envName];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Live ingest for one org. Owns reconnect/backoff; the transport only supplies events.
export function startOrg(store, creds, opts = {}) {
  const publish = opts.publish || (() => {});
  const log = opts.log || (() => {});
  const transport = opts.transport || pickTransport(creds);   // opts.transport: test injection only
  const normalize = makeNormalizer({ store, creds, opts });
  let conn = null, stopped = false, backoff = 1000;

  // --- Heartbeat --------------------------------------------------------------------------
  // Incident this exists to catch (Aug 2026): one org's Socket Mode connection reported
  // `onOpen` and then never delivered another event for ~2 days. The container stayed
  // "running" (RestartCount 0), the log's last line was "socket mode open", and
  // scripts/healthcheck.mjs greps the tail for that same string forever — so a stale line
  // from days earlier read as "healthy" indefinitely. It proves a socket *was once* opened,
  // not that it is *currently* delivering. This timer guarantees a log line every
  // `heartbeatMs` regardless of Slack traffic, carrying exactly what tells the two states
  // apart: seconds since the last event actually arrived, and whether the transport still
  // believes it's connected. healthcheck.mjs keys its staleness check off log recency, which
  // this line is what keeps fresh on an otherwise-idle connection.
  let connected = false, lastEventAt = Date.now();
  const heartbeatMs = msSetting(opts, 'heartbeatMs', 'SLACKLINE_HEARTBEAT_MS', 5 * 60 * 1000);
  // Opt-in, default off: Slack itself sends periodic `disconnect` envelopes to refresh the
  // connection, so hours of true silence on a CONNECTED socket is anomalous — but a too-eager
  // reconnect loop would trade one silent-failure mode for a noisier one. Only fires while
  // `connected` is true, so it never competes with the backoff loop below: that loop already
  // owns recovering a socket the transport told us is closed (or fatally dead); this only
  // refreshes one the transport still claims is open but has gone quiet past all reason.
  const idleReconnectMs = msSetting(opts, 'idleReconnectMs', 'SLACKLINE_IDLE_RECONNECT_MS', 0);
  let heartbeatTimer = null;
  function heartbeat() {
    const idleSec = Math.round((Date.now() - lastEventAt) / 1000);
    log(`[${creds.org}] heartbeat connected=${connected} idleSec=${idleSec}`);
    if (idleReconnectMs > 0 && connected && idleSec * 1000 >= idleReconnectMs) {
      log(`[${creds.org}] heartbeat: idle ${idleSec}s while connected >= SLACKLINE_IDLE_RECONNECT_MS — forcing reconnect`);
      connected = false;
      lastEventAt = Date.now();   // don't re-trigger every tick while the new connection handshakes
      open();
    }
  }
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(heartbeat, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();   // never the reason the process stays alive
  }
  // -----------------------------------------------------------------------------------------

  function open() {
    if (stopped) return;
    // Socket Mode sends its `disconnect` envelope up to ~10s BEFORE actually closing the
    // socket (warm handover): onClose fires, we schedule a reconnect, but the still-live old
    // socket would otherwise be orphaned the instant `conn` below is overwritten — stop() could
    // then only ever close the newest one. Close whatever's still open first.
    try { conn && conn.close(); } catch {}
    conn = transport.connect({
      creds, log,
      // Reset backoff on a SUCCESSFUL open, not on every connect() attempt — resetting
      // on attempt would mask outages behind a flat ~2s retry loop forever instead of
      // backing off exponentially (see task-6 ruling).
      onOpen: () => { backoff = 1000; connected = true; lastEventAt = Date.now(); },
      onEvent: (ev) => { lastEventAt = Date.now(); normalize(ev).then(rec => { if (rec) publish(rec); }).catch(() => {}); },
      onClose: (err, fatal) => {
        connected = false;
        if (stopped) return;
        if (err) log(`[${creds.org}] ${transport.name}: ${err.message}`);
        if (fatal) return log(`[${creds.org}] fatal — not reconnecting`);
        backoff = Math.min(backoff * 2, 30000);
        log(`[${creds.org}] ${transport.name} closed — reconnecting in ${backoff}ms`);
        setTimeout(open, backoff);
      },
    });
  }
  open();
  return { stop() { stopped = true; if (heartbeatTimer) clearInterval(heartbeatTimer); try { conn && conn.close(); } catch {} } };
}
