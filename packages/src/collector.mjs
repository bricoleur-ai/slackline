// slackline collector — run near where you use Slack. Logs in once via a
// browser, reads the session token + cookie, and pushes them to your hub.
// Re-run any time to refresh a rotated session.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
import { writeFileSync, chmodSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const HUB = (arg('hub', process.env.SLACKLINE_HUB || 'http://localhost:8790')).replace(/\/$/, '');
const SECRET = arg('secret', process.env.SLACKLINE_SECRET || '');
const TEAM = arg('team', '');
const ORG = arg('org', '');
const OUT = arg('out', '');   // write tokens.json here instead of POSTing to a hub
const PROFILE = arg('profile', fileURLToPath(new URL('./pw-profile', import.meta.url)));

console.log(`[collector] hub=${HUB} team=${TEAM || '(auto)'}`);
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1200, height: 820 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://app.slack.com/client' + (TEAM ? '/' + TEAM : ''), { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log('[collector] sign in to Slack in the window; waiting up to 5 min…');

const deadline = Date.now() + 300000; let tok, team, user;
while (Date.now() < deadline) {
  const got = await page.evaluate((want) => {
    try { const c = JSON.parse(localStorage.getItem('localConfig_v2') || '{}'); const t = c.teams || {};
      let k = want && t[want]?.token ? want : (c.lastActiveTeamId && t[c.lastActiveTeamId]?.token ? c.lastActiveTeamId : Object.keys(t).find(x => t[x]?.token));
      if (!k) return null; return { team: k, token: t[k].token, user: t[k].user_id || t[k].self?.id || null };
    } catch { return null; }
  }, TEAM).catch(() => null);
  if (got?.token) { tok = got.token; team = got.team; user = got.user; break; }
  await page.waitForTimeout(2000);
}
if (!tok) { console.log('[collector] no token captured — did you finish signing in?'); await ctx.close(); process.exit(1); }
const d = (await ctx.cookies('https://slack.com')).find(c => c.name === 'd');
await ctx.close();
if (!d) { console.log('[collector] token found but no d cookie'); process.exit(2); }

const org = ORG || team;
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ team, user, token: tok, d: d.value }));
  try { chmodSync(OUT, 0o600); } catch {}
  console.log('[collector] wrote %s (team %s, user %s). Point SLACKLINE_TOKENS_FILE at it.', OUT, team, user);
  process.exit(0);
}
const r = await fetch(HUB + '/tokens', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-slackline-secret': SECRET },
  body: JSON.stringify({ org, team_name: team, token: tok, cookie: d.value, user_id: user }),
}).catch(e => ({ ok: false, status: 'network:' + e.message }));
console.log('[collector] pushed org=%s user=%s -> %s : %s', org, user, HUB, r.status === 200 ? 'OK ✅' : ('FAILED ' + r.status));
process.exit(r.status === 200 ? 0 : 3);
