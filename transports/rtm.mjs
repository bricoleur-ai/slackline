import WebSocket from 'ws';
import { api } from '../slack.mjs';

// --- Deprecation-signal detection (warning only — never touches retry/fatal semantics) ---
//
// Slack is retiring classic apps/legacy bots off rtm.connect; slackline's user-mode session
// token (xoxc-) isn't named in that shutdown, but it rides the same undocumented endpoint, which
// could be withdrawn without notice. A withdrawal would look exactly like a generic connect
// failure retrying forever — indistinguishable in the logs from routine session-token rotation.
// This surfaces the specific error shapes that are actually diagnostic, without changing what
// ingest.mjs does in response to them. See docs/rtm-deprecation.md.
//
// Two tiers, because not every rtm.connect failure means the same thing:
//  - STRONG_SIGNAL_ERRORS are Slack error codes that, per rtm.connect's own documented error
//    table, mean the endpoint/token-type itself was rejected — not "try again later".
//  - invalid_auth is ambiguous: it's also the normal shape of a rotated/expired session token,
//    which recovers on its own. Only worth a warning once it stops looking like a blip.
const STRONG_SIGNAL_ERRORS = new Set(['not_allowed_token_type', 'deprecated_endpoint', 'method_deprecated']);
const STREAK_THRESHOLD = 5;               // consecutive ambiguous failures before they read as "persistent"
const WARN_COOLDOWN_MS = 30 * 60 * 1000;  // re-announce at most every 30min so a long outage doesn't spam the log

const deprecationState = new Map();  // creds.org -> { streak, lastWarn }

function noteRtmSuccess(org) { deprecationState.delete(org); }

function noteRtmFailure(creds, error, log) {
  const org = creds.org || 'default';
  const s = deprecationState.get(org) || { streak: 0, lastWarn: 0 };
  s.streak += 1;
  const strong = STRONG_SIGNAL_ERRORS.has(error);
  const persistent = s.streak >= STREAK_THRESHOLD;
  if ((strong || persistent) && Date.now() - s.lastWarn > WARN_COOLDOWN_MS) {
    s.lastWarn = Date.now();
    const why = strong
      ? `rtm.connect just returned '${error}' — that error code means Slack rejected the endpoint or token type outright, not a transient issue.`
      : `rtm.connect has failed with '${error}' ${s.streak} times in a row without a single successful connect — that pattern doesn't match routine session-token rotation, which normally recovers.`;
    log(`[${org}] WARNING: ${why} This is consistent with Slack having withdrawn undocumented rtm.connect ` +
      'access for user session tokens as part of its classic-app/RTM retirement. If Web API calls with this ' +
      'same token still succeed, that confirms it: only realtime is affected. See docs/rtm-deprecation.md ' +
      'for how to confirm and migrate to app mode (Socket Mode).');
  }
  deprecationState.set(org, s);
}

// User-token transport: rtm.connect issues a short-lived wss URL.
// WebSocketImpl defaults to the real `ws` client; connect() accepts an override so tests can
// drive the socket lifecycle without a real connection (mirrors transports/socket.mjs).
export function connect({ creds, onEvent, onClose, onOpen, log, WebSocketImpl = WebSocket }) {
  let ws = null, stopped = false;
  (async () => {
    const rtm = await api(creds, 'rtm.connect').catch(() => null);
    if (stopped) return;
    if (!rtm || !rtm.ok) {
      const error = rtm ? rtm.error : 'network';
      noteRtmFailure(creds, error, log);
      // NON-fatal, deliberately: session tokens rotate and recover, so the caller must retry.
      // The warning above is purely additive — it never changes this return value.
      return onClose(new Error('rtm.connect: ' + error), false);
    }
    noteRtmSuccess(creds.org || 'default');   // a successful grant means the endpoint/token-type still works
    ws = new WebSocketImpl(rtm.url, { headers: { Origin: 'https://app.slack.com', Cookie: 'd=' + creds.cookie } });
    ws.on('open', () => { log(`[${creds.org}] rtm socket open`); onOpen && onOpen(); });
    ws.on('message', (buf) => { let ev; try { ev = JSON.parse(buf.toString()); } catch { return; } onEvent(ev); });
    ws.on('error', (e) => log(`[${creds.org}] rtm ws error ${e.message}`));
    ws.on('close', () => { if (!stopped) onClose(null, false); });
  })();
  return { close() { stopped = true; try { ws && ws.close(); } catch {} } };
}
