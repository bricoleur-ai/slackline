// One hub /tail stream per workspace, for the adapters that run unattended beside a session:
// the Codex/Muse listener (agents/listen.mjs) and the OpenCode plugin.
//
// An unreachable hub is not fatal here: nobody is watching, and a hub that happens to be down
// when the session starts would leave that session without push for its whole life, silently.
// So the first connection is retried, and RemoteTail's own reconnect loop takes over once it
// has succeeded. A hub that ANSWERS with 401/403 is different: retrying never fixes a wrong
// workspace name or a key without that scope, so that one stream is logged once and given up on.
//
// mcp.mjs uses this only for a routed registration (SLACKLINE_ROUTES=1, no explicit channel
// list); its legacy modes keep awaiting each connect and exiting on failure.
import { RemoteTail } from '../remote.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function openStreams({ cfg, streams, onRow, log = () => {}, TailImpl = RemoteTail, sleepImpl = sleep }) {
  let stopped = false;
  const tails = [];
  const connecting = streams.map(async (s) => {
    const tail = new TailImpl({ ...cfg, org: s.org }, { channels: s.channels, log,
      // origin=hub is this machine's own agents posting through the hub. The subscription
      // already asks the hub to drop those; this is the same belt-and-braces guard as mcp.mjs.
      onMessage: (row) => { if (!stopped && row.origin !== 'hub') onRow(row, s.org); } });
    tails.push(tail);
    let wait = 2000;
    while (!stopped) {
      try { await tail.connect(); return; }
      catch (e) {
        const refused = /-> (401|403)\b/.exec(e.message);
        if (refused) {
          log(`the hub refused the stream for workspace "${s.org}" (HTTP ${refused[1]}): check the workspace name in routes.json and that the key covers it; no push from this stream (${e.message})`);
          return;
        }
        log(`hub not reachable for ${s.org} (${e.message}); retrying in ${wait}ms`);   // e.message names the URL, never the key
        await sleepImpl(wait);
        wait = Math.min(wait * 2, 60000);
      }
    }
  });
  return {
    ready: Promise.all(connecting).then(() => {}),
    stop() { stopped = true; for (const t of tails) t.stop(); },
  };
}
