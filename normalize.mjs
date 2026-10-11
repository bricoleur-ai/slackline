// Shared event normalizer: turns a raw Slack event (RTM or Socket Mode — the two
// transports deliver the same core fields, see task-3 brief) into a store record,
// a signal object for subscribers, or null to drop. Never read a transport-specific
// field here (event_ts, channel_type, envelope wrappers) — that breaks RTM/Socket parity.
import { resolveUser, resolveChannel, hydrateThread, archiveFiles } from './slack.mjs';

// Is this event authored by us? App mode knows exactly (bot_id/bot_user_id are ours).
// User mode cannot tell from the event alone and must consult the outbound guard.
function isSelfAuthored(ev, creds) {
  if (creds.mode === 'app') return ev.bot_id === creds.bot_id || ev.user === creds.bot_user_id;
  return (ev.user || ev.bot_id) === (creds.user_id || null);   // || null: undefined author must never match an unset user_id
}

export function makeNormalizer({ store, creds, opts = {} }) {
  const org = creds.org;
  // Real-time by default; tests may inject a synchronous stand-in to exercise the
  // retry loop below without paying its wall-clock cost.
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));

  // User mode only: the socket echo can beat /say's outbound write, so recheck briefly.
  async function classifySelf(ev) {
    const pkey = org + '|' + ev.channel + '|' + (ev.text || '').trim();
    const exp = store.pendingOutbound.get(pkey);
    if (exp && exp > Date.now()) { store.pendingOutbound.delete(pkey); return 'hub'; }
    if (await store.isOutbound(org, ev.channel, ev.ts)) return 'hub';
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      if (await store.isOutbound(org, ev.channel, ev.ts)) return 'hub';
    }
    return 'human';
  }

  return async function normalize(ev) {
    if (ev.type === 'reaction_added' || ev.type === 'reaction_removed') {
      const it = ev.item;
      if (it && it.type === 'message' && it.channel && it.ts) {
        await store.setReaction(org, it.channel, it.ts, ev.reaction, ev.user, ev.type === 'reaction_added');
        resolveUser(store, org, creds, ev.user).catch(() => {});
        return { org, channel: it.channel, ts: it.ts, type: ev.type,
                 emoji: ev.reaction, user: ev.user, time: new Date().toISOString() };
      }
      return null;
    }
    if (ev.type !== 'message') return null;

    if (ev.subtype === 'message_deleted') {
      if (ev.deleted_ts) await store.markDeleted(org, ev.channel, ev.deleted_ts);
      return { org, channel: ev.channel, ts: ev.deleted_ts || ev.ts,
               deleted: true, type: 'message_deleted', time: new Date().toISOString() };
    }

    if (ev.subtype === 'message_changed') {
      const nm = ev.message;
      if (!nm || !nm.ts) return null;
      const files = (nm.files || []).map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private }));
      await store.putMessage({ org, channel: ev.channel, ts: nm.ts, thread_ts: nm.thread_ts || nm.ts,
        user: nm.user || nm.bot_id, subtype: null, text: nm.text || '',
        has_files: files.length > 0, files_json: files.length ? JSON.stringify(files) : null,
        edited: nm.edited ? 1 : 0, at: Math.round(parseFloat(nm.ts) * 1000) });
      if (!nm.edited) return null;                       // unfurl: store it, don't notify
      return { org, channel: ev.channel, ts: nm.ts, edited: true, type: 'message_edited',
               text: nm.text || '', time: new Date().toISOString() };
    }

    if (ev.subtype && !['thread_broadcast', 'me_message', 'file_share'].includes(ev.subtype)) return null;

    resolveUser(store, org, creds, ev.user).catch(() => {});
    resolveChannel(store, org, creds, ev.channel).catch(() => {});
    const files = (ev.files || []).map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private }));

    let origin = 'peer';
    if (isSelfAuthored(ev, creds)) origin = creds.mode === 'app' ? 'hub' : await classifySelf(ev);

    const rec = {
      org, channel: ev.channel, ts: ev.ts, thread_ts: ev.thread_ts || ev.ts,
      user: ev.user || ev.bot_id, subtype: ev.subtype || null, text: ev.text || '',
      has_files: files.length > 0, files_json: files.length ? JSON.stringify(files) : null,
      edited: ev.edited ? 1 : 0, origin, at: Math.round(parseFloat(ev.ts) * 1000),
    };
    await store.putMessage(rec);
    if (files.length && opts.blobRoot) archiveFiles(store, creds, org, ev.channel, ev.ts, files, opts.blobRoot).catch(() => {});
    if (opts.hydrateThreads !== false && ev.thread_ts && ev.thread_ts !== ev.ts) {
      // opts.hydrateThread lets tests observe this fire-and-forget call without a real network hit.
      (opts.hydrateThread || hydrateThread)(store, org, creds, ev.channel, ev.thread_ts).catch(() => {});
    }
    return rec;
  };
}
