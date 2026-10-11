// Shared bridge core: everything four delivery modes have in common — credential-scoped
// ingest, channel filtering, the origin=hub self-guard, slash-command echo skip, the durable
// (file-backed) dedupe, the 👀 ack, attachment download, the report-file writer, and the
// startup backfill sweep. Each guard below exists because its absence caused a real failure
// (duplicate reports, self-replies, missed backfill) — do not weaken any of them.
//
// The ONLY thing that differs per mode is delivery: how the agent is told a report landed.
// That is injected as `deliver(pointerLine, meta)` — see bridges/tmux.mjs, headless.mjs,
// channels.mjs for the three implementations, and bridge.mjs for how they're selected.
import { writeFileSync, existsSync } from 'node:fs';
import { startOrg } from '../ingest.mjs';
import { api, resolveUser, fileAuthHeaders } from '../slack.mjs';

// Download attachments ourselves rather than waiting on the store's async archive pass — the
// agent needs a path that exists NOW, and a race here means it opens a file that isn't there.
export async function saveFiles(creds, files, dir, log) {
  const out = [];
  for (const f of files) {
    if (!f.url) continue;
    const safe = String(f.name || f.id).replace(/[^\w.\-]/g, '_').slice(0, 120);
    const path = `${dir}/${f.id}_${safe}`;
    try {
      const r = await fetch(f.url, { headers: fileAuthHeaders(creds) });
      if (!r.ok) { log(`file ${f.id} download failed: ${r.status}`); continue; }
      writeFileSync(path, Buffer.from(await r.arrayBuffer()));
      out.push({ path, name: f.name, mimetype: f.mimetype });
    } catch (e) { log(`file ${f.id} error: ${e.message}`); }
  }
  return out;
}

// Provenance + content + the mechanism to answer, and NOTHING else. How to HANDLE a report is
// the operator's policy (their own CLAUDE.md / prompt) — the bridge is transport and states
// facts only. Do not add instructions telling the receiving agent how to behave here.
export function buildReport({ name, rec, channelName, channelId, teamName, saved, link, replyCmd }) {
  return [
    `# Slack message from ${name}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| source | Slack, channel \`${channelName}\` (\`${channelId}\`) |`,
    `| workspace | ${teamName || '?'} |`,
    `| from | ${name} (\`${rec.user}\`) |`,
    `| posted | ${new Date(Math.round(parseFloat(rec.ts) * 1000)).toISOString()} |`,
    `| message ts | \`${rec.ts}\` |`,
    ...(link ? [`| permalink | ${link} |`] : []),
    ``,
    `## Message`,
    ``,
    rec.text || '(no text)',
    ``,
    ...(saved.length ? [`## Attachments (downloaded, open these directly)`, ``,
      ...saved.map(f => `- ${f.path}   (${f.mimetype || 'file'}${f.name ? `, "${f.name}"` : ''})`), ``] : []),
    `## Replying`,
    ``,
    `This reply lands in the same Slack thread, so the sender sees it as an answer:`,
    ``,
    '```bash',
    replyCmd,
    '```',
    ``,
  ].join('\n');
}

// Wires: startOrg -> per-message report -> deliver(pointerLine, meta). Returns
// { handle, backfill, start } so an entrypoint can drive the whole thing, and tests can
// call handle()/backfill() directly against synthetic records without a real socket.
export function createBridge({ store, creds, channel, channelName, qaDir, log, deliver }) {
  const seen = new Set();

  async function handle(rec) {
    if (rec.channel !== channel) return;
    if (rec.origin === 'hub') return;                    // never react to our own posts
    if (rec.type) return;                                // reactions/edits/deletes: not QA reports
    if (!rec.text && !rec.has_files) return;
    // Slack posts some slash commands into the channel as ordinary messages with no subtype
    // (e.g. `/invite @bot`), which would otherwise reach the agent as a bogus report.
    if (/^\s*\//.test(rec.text || '')) return log(`skipping slash-command echo: ${rec.text.slice(0, 40)}`);
    const path = `${qaDir}/qa-${rec.ts.replace('.', '-')}.md`;
    // `seen` dies with the process, and Slack redelivers un-acked Socket Mode envelopes — so a
    // restart mid-flight relays the same report twice and the agent does the work, and replies,
    // twice. The report file on disk is the durable marker that survives a restart.
    if (seen.has(rec.ts) || existsSync(path)) return;
    seen.add(rec.ts);

    const who = await resolveUser(store, creds.org, creds, rec.user).catch(() => null);
    const name = (who && (who.real_name || who.display_name || who.name)) || rec.user;

    const files = rec.files_json ? (typeof rec.files_json === 'string' ? JSON.parse(rec.files_json) : rec.files_json) : [];
    const saved = files.length ? await saveFiles(creds, files, qaDir, log) : [];

    const link = await api(creds, 'chat.getPermalink', { channel, message_ts: rec.ts })
      .then(r => (r.ok ? r.permalink : null)).catch(() => null);

    writeFileSync(path, buildReport({
      name, rec, channelName, channelId: channel, teamName: creds.team_name, saved, link,
      replyCmd: `node ${process.cwd()}/scripts/slack-reply.mjs --thread ${rec.ts} --text "..."`,
    }));

    log(`message from ${name} (${saved.length} file(s)) -> ${path}`);
    const pointer = `New Slack message from ${name} in ${channelName}${saved.length ? ` (${saved.length} attachment${saved.length > 1 ? 's' : ''})` : ''} — details and how to reply are in ${path}`;
    try { await deliver(pointer, { path, rec, name, saved, channelName }); }
    catch (e) { log(`deliver error: ${e.message}`); }
  }

  // Socket Mode only pushes messages that arrive while we're connected, so anything posted
  // while the bridge was down would be lost silently — unacceptable when a person is waiting
  // on a reply. On start, sweep recent history and pick up anything not yet handled.
  //
  // The report file on disk is the "already handled" marker. It is not a 👀 reaction:
  // reacting to every message the bridge merely SAW is noise in a channel humans read, and
  // it would make a Slack write load-bearing for restart correctness. The report file is the
  // marker handle() already dedupes on, so the two agree by construction.
  async function backfill(limit = 30) {
    const h = await api(creds, 'conversations.history', { channel, limit: String(limit) }).catch(() => null);
    if (!h || !h.ok) { log(`backfill skipped: ${h ? h.error : 'network'}`); return; }
    const mine = creds.bot_user_id, myBot = creds.bot_id;
    const pending = h.messages.filter(m =>
      !m.subtype &&                                                   // skip joins/leaves/system
      m.user !== mine && m.bot_id !== myBot &&                        // skip our own posts
      !existsSync(`${qaDir}/qa-${m.ts.replace('.', '-')}.md`));
    if (!pending.length) return log('backfill: nothing pending');
    log(`backfill: ${pending.length} unhandled message(s)`);
    for (const m of pending.reverse()) {
      await handle({
        channel, ts: m.ts, user: m.user || m.bot_id, text: m.text || '',
        origin: 'peer', has_files: !!(m.files && m.files.length),
        files_json: m.files ? JSON.stringify(m.files.map(f => ({ id: f.id, name: f.name,
          mimetype: f.mimetype, size: f.size, url: f.url_private_download || f.url_private }))) : null,
      }).catch(e => log(`backfill error on ${m.ts}: ${e.message}`));
    }
  }

  function start() {
    return startOrg(store, creds, {
      hydrateThreads: true,
      log,
      publish: (rec) => { handle(rec).catch(e => log(`handler error: ${e.message}`)); },
    });
  }

  return { handle, backfill, start };
}
