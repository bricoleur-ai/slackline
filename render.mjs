// Render stored messages into a compact transcript both a human and an LLM read easily.
function hhmm(ts) { const d = new Date(Math.round(parseFloat(ts) * 1000)); return d.toISOString().slice(11, 16); }

export async function nameFor(store, org, userId) {
  if (!userId) return 'unknown';
  const u = await store.getUser(org, userId);
  return (u && (u.display_name || u.real_name || u.name)) || userId;
}
export async function channelLabel(store, org, channelId) {
  const c = await store.getChannel(org, channelId);
  if (!c) return channelId;
  if (c.is_im) return 'DM';
  if (c.is_mpim) return 'group-dm';
  return '#' + (c.name || channelId);
}

// messages[] (asc) -> a plain-text transcript with resolved names + file markers.
export async function transcript(store, org, messages, opts = {}) {
  const lines = [];
  for (const m of messages) {
    const who = await nameFor(store, org, m.user);
    if (m.deleted && !opts.includeDeleted) { lines.push(`[${hhmm(m.ts)}] ${who}: [deleted message]`); continue; }
    let files = '';
    if (m.has_files && m.files_json) {
      const f = Array.isArray(m.files_json) ? m.files_json : JSON.parse(m.files_json);
      files = ' ' + f.map(x => `[file: ${x.name}]`).join(' ');
    }
    const edited = m.edited ? ' (edited)' : '';
    lines.push(`[${hhmm(m.ts)}] ${who}: ${(m.text || '').replace(/\n/g, ' ')}${files}${edited}`);
  }
  return lines.join('\n');
}

// A structured message projection with resolved names (for LLM/JSON consumers).
export async function shape(store, org, m, opts = {}) {
  if (m.deleted && !opts.includeDeleted) {
    return { channel: m.channel, channel_name: await channelLabel(store, org, m.channel),
      ts: m.ts, thread_ts: m.thread_ts, is_reply: !!(m.thread_ts && m.thread_ts !== m.ts),
      time: new Date(Math.round(parseFloat(m.ts) * 1000)).toISOString(),
      user: m.user, user_name: await nameFor(store, org, m.user), origin: m.origin || null,
      deleted: true, text: '[deleted message]', has_files: false, files: [], edited: !!m.edited, reactions: m.reactions || {} };
  }
  return {
    channel: m.channel, channel_name: await channelLabel(store, org, m.channel),
    ts: m.ts, thread_ts: m.thread_ts, is_reply: !!(m.thread_ts && m.thread_ts !== m.ts),
    time: new Date(Math.round(parseFloat(m.ts) * 1000)).toISOString(),
    user: m.user, user_name: await nameFor(store, org, m.user), origin: m.origin || null,
    deleted: false, reactions: m.reactions || {}, text: m.text, has_files: !!m.has_files,
    files: m.has_files && m.files_json ? (Array.isArray(m.files_json) ? m.files_json : JSON.parse(m.files_json)) : [],
    edited: !!m.edited,
  };
}
