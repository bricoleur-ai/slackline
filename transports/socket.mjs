import WebSocket from 'ws';

// Pure envelope logic, separated so it is testable without a socket.
// Ack FIRST, then process: normalization does network I/O and can outlast the ack window.
export function makeEnvelopeHandler({ send, onEvent, onClose, log }) {
  const seen = new Set();                       // event_id dedupe (Slack redelivers)
  return function handle(m) {
    if (!m || typeof m !== 'object') return;    // guard against a bare `null`/non-object frame
    if (m.type === 'hello') {
      const secs = m.debug_info && m.debug_info.approximate_connection_time;
      log(`socket hello app=${m.connection_info && m.connection_info.app_id} refresh~${secs}s`);
      return;
    }
    if (m.type === 'disconnect') {
      // link_disabled means Socket Mode was turned off for the app: only a human can fix it.
      const fatal = m.reason === 'link_disabled';
      return onClose(fatal ? new Error('socket mode disabled for this app (link_disabled)') : null, fatal);
    }
    if (!m.envelope_id) return;
    send(JSON.stringify({ envelope_id: m.envelope_id }));      // ack first, always
    if (m.type !== 'events_api') return;                       // slash_commands/interactive: ignore
    const p = m.payload;
    if (!p || !p.event) return;
    if (p.event_id) {
      if (seen.has(p.event_id)) return;
      seen.add(p.event_id);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
    }
    onEvent(p.event);
  };
}

// WebSocketImpl defaults to the real `ws` client; connect() accepts an override
// so tests can drive the disconnect/close race without a real socket.
export function connect({ creds, onEvent, onClose, onOpen, log, WebSocketImpl = WebSocket }) {
  let ws = null, stopped = false, closed = false;
  // Slack closes the underlying socket shortly after ANY disconnect envelope,
  // including link_disabled, which would otherwise re-fire onClose as (null, false)
  // and downgrade a fatal signal into "safe to reconnect". First call wins.
  const finish = (err, fatal) => { if (closed) return; closed = true; onClose(err, fatal); };
  (async () => {
    const r = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + creds.app_token,
                 'Content-Type': 'application/x-www-form-urlencoded' },
    }).then(x => x.json()).catch(() => null);
    if (stopped) return;
    if (!r || !r.ok) {
      const err = r ? r.error : 'network';
      // Bad/revoked app token will never recover by retrying.
      return finish(new Error('apps.connections.open: ' + err),
                    err === 'invalid_auth' || err === 'not_allowed_token_type');
    }
    ws = new WebSocketImpl(r.url);
    const handle = makeEnvelopeHandler({
      send: (m) => { try { ws.send(m); } catch {} }, onEvent, onClose: finish, log });
    ws.on('open', () => { log(`[${creds.org}] socket mode open`); onOpen && onOpen(); });
    ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } handle(m); });
    ws.on('error', (e) => log(`[${creds.org}] socket ws error ${e.message}`));
    ws.on('close', () => { if (!stopped) finish(null, false); });
  })();
  return { close() { stopped = true; try { ws && ws.close(); } catch {} } };
}
