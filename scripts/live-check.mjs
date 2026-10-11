// Manual live verification of app-mode ingest against a real Slack workspace.
//
// What it needs: a Slack app with Socket Mode on, the bot scopes and the event subscriptions
// listed in the README ("Getting a credential"), installed in a workspace you can experiment
// in. Use a throwaway workspace or a dedicated test channel, not one real people read.
//
// Environment (never printed):
//   SLACKLINE_APP_TOKEN  the xapp- app-level token (opens the Socket Mode connection)
//   SLACKLINE_BOT_TOKEN  the xoxb- bot token (Web API calls)
//   Optional: SLACKLINE_LIVE_CHECK_WINDOW_MS  how long to wait for your own message at the
//   end (default 20000).
//
// Run: node scripts/live-check.mjs [channel-name]   (default: slackline-test)
//
// What it does: finds or creates the channel and joins it, starts the ingest runner, waits for
// Socket Mode to open, posts one message as the bot and waits for it to come back. Then it
// waits for the one human step: post a message in that channel from your own account to see it
// arrive as origin=peer.
//
// Exit 0 proves that the credential works, the socket connects, events for the channel arrive,
// and the bot's own post is classified origin=hub (the loop guard: without it an agent would
// answer itself forever). It does not wait for your message, so it does not prove the
// origin=peer classification; read the [event] line printed during the wait.
//
// This is NOT part of `npm test` — it needs real credentials and mutates a live workspace
// (creates/joins a channel, posts a message). It always exits: a live socket keeps the event
// loop alive, so every exit path below stops the ingest runner before calling process.exit().
import { createStore } from '../db.mjs';
import { startOrg } from '../ingest.mjs';
import { resolveCreds, appCredsFromEnv } from '../creds.mjs';
import { api } from '../slack.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll `pred` until true or `timeoutMs` elapses; returns whether it became true.
async function waitUntil(pred, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
  return true;
}

// Paginate conversations.list looking for one channel by name. Returns {channel} or {error}.
// A workspace can have >1000 channels, so a single unpaginated call
// can silently miss the target and go straight to a spurious `name_taken` on create.
async function findChannel(creds, name, types) {
  let cursor;
  for (let page = 0; page < 20; page++) {          // hard cap: never loop forever on a bad cursor
    const r = await api(creds, 'conversations.list', { types, limit: '1000', ...(cursor ? { cursor } : {}) });
    if (!r.ok) return { error: r.error };
    const found = (r.channels || []).find((c) => c.name === name);
    if (found) return { channel: found };
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (!cursor) return { channel: null };
  }
  return { channel: null };
}

let runner = null, exiting = false;
// Single exit path so every early-return also stops the socket and never leaves the
// process hanging on an open connection.
async function finish(code) {
  if (exiting) return;
  exiting = true;
  try { runner && runner.stop(); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => finish(130));

async function main() {
  process.env.SLACKLINE_STORE = 'memory';        // never touch a real db file/cluster for this check — unconditional: an operator with SLACKLINE_STORE=postgres exported would otherwise get this check's test data written into production
  const store = createStore();
  await store.init();

  const creds = await resolveCreds(store);
  if (!creds || creds.mode !== 'app') {
    // Distinguish "tokens absent" from "tokens present but rejected" without ever printing them.
    if (creds && creds.mode !== 'app') {
      console.error(`Resolved ${creds.mode}-mode credentials, but this check requires app-mode (bot) credentials.`);
      console.error('Unset any SLACKLINE_XOXC/SLACKLINE_XOXD/SLACKLINE_TOKENS_FILE, or set SLACKLINE_APP_TOKEN + SLACKLINE_BOT_TOKEN.');
    } else if (appCredsFromEnv()) {
      console.error('SLACKLINE_APP_TOKEN/SLACKLINE_BOT_TOKEN are set, but bot identity could not be verified (auth.test failed).');
      console.error('Check the tokens are current — they are only valid for the life of the `slack run` process that minted them.');
    } else {
      console.error('SLACKLINE_APP_TOKEN and SLACKLINE_BOT_TOKEN are not set. See the README, "Getting a credential", for how to get them.');
    }
    return finish(1);
  }
  console.log(`bot=${creds.bot_user_id} bot_id=${creds.bot_id} team=${creds.team_name} org=${creds.org}`);

  const name = process.argv[2] || 'slackline-test';
  let { channel: ch, error } = await findChannel(creds, name, 'public_channel');
  if (error) { console.error('conversations.list failed:', error); return finish(1); }
  if (!ch) {
    const r = await api(creds, 'conversations.create', { name });
    if (r.ok) { ch = r.channel; console.log('created #' + name); }
    else if (r.error === 'name_taken') {
      // Racing another run, or the channel is private/archived and so absent from the
      // public_channel listing above — look again across both before giving up.
      console.log(`#${name} reports name_taken — re-checking public + private channels`);
      const retry = await findChannel(creds, name, 'public_channel,private_channel');
      if (retry.error) { console.error('conversations.list failed:', retry.error); return finish(1); }
      ch = retry.channel;
      if (!ch) {
        console.error(`#${name} is name_taken but not visible via conversations.list — it is likely archived.`);
        console.error('Unarchive it, or pass a different channel name as argv[2].');
        return finish(1);
      }
    } else { console.error('conversations.create failed:', r.error); return finish(1); }
  }
  const joined = await api(creds, 'conversations.join', { channel: ch.id });
  if (!joined.ok) {
    console.error(`conversations.join failed: ${joined.error}`);
    console.error('If the channel is private, invite the bot manually first — apps cannot self-join private channels.');
    return finish(1);
  }
  console.log(`channel #${name} = ${ch.id}`);

  let connected = false, fatal = null;
  const seen = [];
  runner = startOrg(store, creds, {
    log: (m) => {
      console.log('[ingest]', m);
      if (/socket mode open/.test(m)) connected = true;
      if (/fatal — not reconnecting/.test(m)) fatal = m;   // e.g. link_disabled — retrying would just spin
    },
    publish: (rec) => {
      seen.push(rec);
      console.log(`[event] origin=${rec.origin} user=${rec.user} text=${JSON.stringify(rec.text)}`);
    },
  });

  const opened = await waitUntil(() => connected || fatal, 15000);
  if (fatal) { console.error('socket connection failed:', fatal); return finish(1); }
  if (!opened) {
    console.error('Socket Mode did not report "open" within 15s.');
    console.error('Check SLACKLINE_APP_TOKEN is a current xapp- token and Socket Mode is enabled in the app manifest.');
    return finish(1);
  }

  const said = await api(creds, 'chat.postMessage', { channel: ch.id, text: `slackline live-check ping ${Date.now()}` });
  if (!said.ok) { console.error('chat.postMessage failed:', said.error); return finish(1); }
  console.log('posted ts=', said.ts);

  const echoed = await waitUntil(() => seen.some((r) => r.ts === said.ts), 15000);
  console.log('\n--- RESULT ---');
  console.log('events seen total:', seen.length);
  if (!echoed) {
    if (seen.length === 0) {
      console.error('FAIL: no events arrived at all within 15s.');
      console.error('Check: was the app reinstalled after its event subscriptions were added (README, "Getting a credential")? Is the bot a member of the channel?');
    } else {
      console.error(`FAIL: ${seen.length} other event(s) arrived, but never our own post (ts=${said.ts}).`);
    }
    return finish(1);
  }
  const mine = seen.filter((r) => r.ts === said.ts);
  const origins = mine.map((r) => r.origin).join(',');
  console.log('own post classified as:', origins);
  if (mine.some((r) => r.origin !== 'hub')) {
    // The one assertion this whole script exists for: if our own post isn't recognized as
    // 'hub', an agent reacting to this channel would reply to itself forever on a live workspace.
    console.error(`FAIL: own post not classified origin=hub (got: ${origins}) — LOOP RISK.`);
    return finish(1);
  }
  console.log('PASS: loop guard correct (own post classified origin=hub)');

  const windowMs = Number(process.env.SLACKLINE_LIVE_CHECK_WINDOW_MS) || 20000;
  console.log(`\nPost a message in #${name} from your own account now to verify origin=peer classification.`);
  console.log(`Waiting ${Math.round(windowMs / 1000)}s for it (Ctrl+C to stop early; the loop-guard result above is already final)...`);
  await sleep(windowMs);
  return finish(0);
}

main().catch((e) => { console.error('live-check crashed:', e.message); finish(1); });
