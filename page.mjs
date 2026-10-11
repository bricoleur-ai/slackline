// The install page served by the hub. Self-contained HTML (no external assets).
export function installPage(base) {
  const osList = [
    ['macOS', 'macos', './collect.sh --hub ' + base + ' --secret <SECRET>'],
    ['Linux', 'linux', './collect.sh --hub ' + base + ' --secret <SECRET>'],
    ['Windows', 'windows', 'collect.bat --hub ' + base + ' --secret <SECRET>'],
  ];
  const cards = osList.map(([label, os, cmd]) => `
    <div class="card">
      <div class="os">${label}</div>
      <a class="dl" href="/packages/slackline-collector-${os}.zip" download>Download collector .zip</a>
      <div class="cmd"><code>${cmd}</code></div>
    </div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>slackline · connect</title>
<style>
  :root{--bg:#faf7fb;--ink:#221b26;--mut:#6c6072;--rule:#e3dae6;--acc:#63215e;--card:#f2ecf4;--code:#efe7f1}
  @media(prefers-color-scheme:dark){:root{--bg:#141019;--ink:#ebe4ec;--mut:#9c8fa3;--rule:#312839;--acc:#d9a6d3;--card:#1d1724;--code:#241c2b}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:3rem 1.25rem 5rem}
  h1{font-size:2.1rem;margin:0 0 .3rem;letter-spacing:-.02em}
  .sub{color:var(--mut);margin:0 0 2rem}
  .steps{counter-reset:s;padding:0;list-style:none;margin:0 0 2.5rem}
  .steps li{counter-increment:s;position:relative;padding:.15rem 0 1.1rem 2.2rem}
  .steps li::before{content:counter(s);position:absolute;left:0;top:0;width:1.5rem;height:1.5rem;
    border-radius:50%;background:var(--acc);color:var(--bg);font-size:.85rem;font-weight:600;
    display:flex;align-items:center;justify-content:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1rem;margin:1rem 0 2.5rem}
  .card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:1.1rem;display:flex;flex-direction:column;gap:.7rem}
  .os{font-weight:700;font-size:1.05rem}
  .dl{display:inline-block;background:var(--acc);color:var(--bg);text-decoration:none;
    padding:.5rem .8rem;border-radius:7px;font-size:.9rem;font-weight:600;text-align:center}
  .cmd{background:var(--code);border-radius:7px;padding:.55rem .7rem;overflow-x:auto}
  code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
  .note{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:1rem 1.2rem;color:var(--mut);font-size:.92rem}
  h2{font-size:1.15rem;margin:2rem 0 .6rem}
  .base{font-family:ui-monospace,monospace;background:var(--code);padding:.15rem .4rem;border-radius:5px}
</style></head><body><div class="wrap">
  <h1>slackline</h1>
  <p class="sub">Connect a Slack workspace to your hub so your agents get live inbounds &amp; context.</p>

  <ol class="steps">
    <li><b>Download</b> the collector for the machine where you actually use Slack.</li>
    <li><b>Run</b> it (command below). First run installs a headless browser; later runs are instant.</li>
    <li><b>Sign in</b> once in the window that opens — that's it. Your session is pushed to the hub.</li>
    <li><b>Re-run</b> any time to refresh a rotated session.</li>
  </ol>

  <div class="grid">${cards}</div>

  <h2>This hub</h2>
  <p>Collectors push to <span class="base">${base}</span>. Replace <code>&lt;SECRET&gt;</code> with your slackline shared secret (the <code>SLACKLINE_SECRET</code> you set in <code>.env</code>).</p>

  <div class="note">
    Your Slack token and cookie are sent <b>only</b> to this hub, over the shared secret, and nothing else leaves your machine.
    The collector needs <b>Node.js 18+</b> installed. Multiple workspaces? Run it once per workspace with a different
    <code>--team &lt;TEAM_ID&gt;</code> and <code>--org &lt;name&gt;</code>.
  </div>
</div></body></html>`;
}
