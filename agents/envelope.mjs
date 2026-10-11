// The text form of a pushed Slack message, for every route except Claude Code's own channel
// events (which mcp.mjs emits natively). It mirrors what Claude Code shows for a channel event
// so an agent reads the same thing whichever adapter delivered it.
//
// Provenance and content, and NOTHING else. How to handle a message is the operator's policy
// (their AGENTS.md / CLAUDE.md), exactly as in bridges/core.mjs — do not add instructions here.
//
// SECURITY: this tag is the only thing marking the text as external in agents that have no
// native "external event" form. Slack users control the message text AND their display name,
// so both are neutralised: attributes lose quotes/angle brackets/newlines, and the body cannot
// contain a closing tag or start a line with an opening one.
const attr = (v) => String(v ?? '').replace(/["<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
const body = (s) => String(s ?? '').replace(/<(\/?)channel/gi, '<$1 channel');

export function envelope(row, org) {
  const files = Array.isArray(row.files) ? row.files : [];
  const who = attr(row.user_name || row.user) || '?';
  const attrs = { source: 'slackline', org, channel: row.channel,
    channel_name: String(row.channel_name || row.channel || '').replace(/^#/, ''),
    user: row.user, user_name: who, ts: row.ts, thread_ts: row.thread_ts || row.ts, origin: row.origin || 'peer' };
  const head = Object.entries(attrs).map(([k, v]) => `${k}="${attr(v)}"`).join(' ');
  const lines = [`${who}: ${row.text || ''}`];
  if (files.length) lines.push(`[${files.length} attachment(s): ${files.map(f => f.name).join(', ')} — not downloaded in remote mode]`);
  return `<channel ${head}>\n${body(lines.join('\n'))}\n</channel>`;
}

// What Muse shows in the title of a cross-session message cell. The envelope is still what the
// model reads; this is only the UI's label.
export function displayContext(row, org) {
  return { sender_display_name: attr(row.user_name || row.user) || '?',
    lane: String(row.channel_name || row.channel || '').replace(/^#/, ''), transport: 'slackline',
    conversation_key: `${org}/${row.channel}/${row.thread_ts || row.ts}`, transport_message_id: String(row.ts) };
}

// For the tmux fallback's pointer line, which is typed into a terminal as keystrokes: nothing
// that a shell or a TUI could interpret survives.
export function plainName(s) { return String(s ?? '').replace(/[^A-Za-z0-9 _.-]/g, '') || '?'; }
