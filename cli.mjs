#!/usr/bin/env node
// Bin dispatcher for the `slackline` command. A bare `slackline` (and `slackline serve`) starts
// the standalone server — unchanged Mode 2 behavior, so the README's documented invocation and
// any existing script/systemd unit pointing at the `slackline` bin keeps working exactly as
// before. `slackline app <cmd>` routes to the provisioning engine (app.mjs) instead. This file is intentionally thin: it parses flags and prints
// results, all the actual logic lives in app.mjs so the MCP tools (mcp.mjs) and the HTTP route (api.mjs) can share it.
import { createStore } from './db.mjs';
import * as app from './app.mjs';
import { exportToFile, importFromFile, copyStores, verifyStores } from './migrate.mjs';
import * as keys from './keys.mjs';

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function printResult(r) {
  // Result objects from app.mjs never carry token fields (see app.mjs's file-header contract) —
  // safe to dump wholesale.
  console.log(JSON.stringify(r, null, 2));
  if (r && r.humanCommand) console.error('\nRun: ' + r.humanCommand);
  if (r && r.instructions) console.error('\n' + r.instructions);
}

async function runServe() {
  await import('./standalone.mjs');   // top-level side effects ARE the server starting; matches `node standalone.mjs`
}

async function runApp(sub, rest) {
  const f = parseFlags(rest);
  const store = createStore(); await store.init();
  const opts = { cwd: process.cwd(), team: f.team, project: f.project, org: f.org,
    persist: !!f.persist, appToken: f['app-token'], botToken: f['bot-token'], appId: f['app-id'] };
  try {
    switch (sub) {
      case 'init': { const r = await app.init(store, opts); printResult(r); process.exitCode = r.ok ? 0 : 1; return; }
      case 'link': {
        if (!opts.appToken || !opts.botToken) {
          console.error('slackline app link requires --app-token xapp-... and --bot-token xoxb-...');
          process.exitCode = 1; return;
        }
        printResult(await app.link(store, opts)); return;
      }
      case 'status': { printResult(await app.status(store, opts.org)); return; }
      case 'doctor': { const r = await app.doctor(store, opts.org); printResult(r); process.exitCode = r.ok ? 0 : 1; return; }
      default:
        console.error('usage: slackline app <init|link|status|doctor> [--team T…] [--org name] [--project name] [--persist] [--app-token xapp-…] [--bot-token xoxb-…]');
        process.exitCode = 1;
    }
  } catch (e) {
    // e.message is always static text here (app.mjs's thrown errors never interpolate a token —
    // see its file-header contract), so this is safe to print verbatim.
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}

// `slackline key <cmd>` — provisions scoped consumer keys (keys.mjs). Kept as thin as runApp:
// all the actual key generation/hashing/scope logic lives in keys.mjs so api.mjs can share it.
// SECURITY: `add` is the ONE place the raw key is ever printed — every other subcommand (and
// keys.mjs's listKeys()) only ever surfaces id/label/orgs/created/last_used/revoked.
async function runKey(sub, rest) {
  const f = parseFlags(rest);
  const store = createStore(); await store.init();
  try {
    switch (sub) {
      case 'add': {
        if (!f.label || f.label === true || !f.orgs || f.orgs === true) {
          console.error(`slackline key add requires --label "name" --orgs org1,org2 (or --orgs '*' for all)`);
          process.exitCode = 1; return;
        }
        const created = await keys.createKey(store, { label: String(f.label), orgs: String(f.orgs) });
        console.log(`key:   ${created.key}`);
        console.log(`id:    ${created.id}`);
        console.log(`label: ${created.label}`);
        console.log(`orgs:  ${created.orgs}`);
        console.error('\nSave this key now — slackline never shows it again (only its hash is stored).');
        return;
      }
      case 'list': { console.log(JSON.stringify(await keys.listKeys(store), null, 2)); return; }
      case 'revoke': {
        const id = rest.find((a) => !a.startsWith('--'));
        if (!id) { console.error('slackline key revoke requires <id>'); process.exitCode = 1; return; }
        const ok = await keys.revokeKey(store, id);
        console.log(JSON.stringify({ ok, id }));
        if (!ok) process.exitCode = 1;
        return;
      }
      // Operator visibility into the Slack-mediated request/approval flow (keyrequest.mjs) —
      // metadata only, straight from the store's own listKeyRequests(); safe to dump wholesale
      // since key_requests rows never carry key material (see that file's header).
      case 'requests': {
        const rows = await store.listKeyRequests();
        const filtered = (f.status && f.status !== true) ? rows.filter((r) => r.status === f.status) : rows;
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }
      default:
        console.error(`usage: slackline key <add|list|revoke|requests> [--label "name"] [--orgs org1,org2|*] [<id>] [--status pending|approved|denied|expired]`);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}

// migrate.mjs's result objects only ever carry row counts and match/mismatch/hash strings for
// tokens/apps (see its file header) — never raw token values — so printResult below is safe to
// dump wholesale, same contract as app.mjs's results.
async function runMigrate(sub, rest) {
  const f = parseFlags(rest);
  const tables = f.tables && f.tables !== true ? String(f.tables).split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const dryRun = !!f['dry-run'];
  try {
    switch (sub) {
      case 'export': {
        if (!f.out || f.out === true) { console.error('slackline migrate export requires --out <file.ndjson>'); process.exitCode = 1; return; }
        const store = createStore(); await store.init();
        printResult(await exportToFile(store, { out: f.out, tables, dryRun })); return;
      }
      case 'import': {
        if (!f.in || f.in === true) { console.error('slackline migrate import requires --in <file.ndjson>'); process.exitCode = 1; return; }
        const store = createStore(); await store.init();
        printResult(await importFromFile(store, { in: f.in, tables, dryRun })); return;
      }
      case 'copy': {
        if (!f.from || f.from === true || !f.to || f.to === true) { console.error('slackline migrate copy requires --from <spec> --to <spec>'); process.exitCode = 1; return; }
        const src = createStore(f.from); await src.init();
        const dst = createStore(f.to); await dst.init();
        printResult(await copyStores(src, dst, { tables, dryRun })); return;
      }
      case 'verify': {
        if (!f.from || f.from === true || !f.to || f.to === true) { console.error('slackline migrate verify requires --from <spec> --to <spec>'); process.exitCode = 1; return; }
        const src = createStore(f.from); await src.init();
        const dst = createStore(f.to); await dst.init();
        const r = await verifyStores(src, dst, { tables });
        printResult(r); process.exitCode = r.ok ? 0 : 1; return;
      }
      default:
        console.error('usage: slackline migrate <export|import|copy|verify> [--tables a,b,c] [--dry-run] (--out|--in <file.ndjson> | --from <spec> --to <spec>)');
        process.exitCode = 1;
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}

const [cmd, sub, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'serve') await runServe();
else if (cmd === 'app') await runApp(sub, rest);
else if (cmd === 'migrate') await runMigrate(sub, rest);
else if (cmd === 'key') await runKey(sub, rest);
// Agent wiring is imported lazily, so the commands above never load it. The Claude launcher
// does not come through here at all: it runs agents/route.mjs directly on every launch,
// which is what keeps that path clear of this file's store imports.
else if (cmd === 'route') { const { main } = await import('./agents/route.mjs'); process.exitCode = main([sub, ...rest].filter(a => a !== undefined)); }
else if (cmd === 'agents') { const { main } = await import('./agents/install.mjs'); process.exitCode = await main([sub, ...rest].filter(a => a !== undefined)); }
else { console.error(`unknown command '${cmd}'. usage: slackline [serve] | slackline app <init|link|status|doctor> | slackline migrate <export|import|copy|verify> | slackline key <add|list|revoke|requests> | slackline route [dir] | slackline agents <install|status|uninstall> [target…]`); process.exitCode = 1; }
