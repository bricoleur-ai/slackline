// Native delivery: hand one pushed Slack message to one agent session, through that agent's
// own CLI. Each route is a single external command, run without a shell.
//
//   codex   codex queue --thread <session> --message <envelope>
//   muse    muse session-message send --target <session> --display-context <json> --json  < envelope
//   tmux    (either agent) envelope to a private file + a one-line pointer PASTED into the pane,
//           submitted only once the pane is seen to show it
//
// SECURITY: Slack content only ever travels as one argv element, as stdin, or as a file. The
// tmux route puts a pointer line into a terminal, and that line holds NO Slack-controlled text
// at all: a fixed sentence and a path we chose (the names are in the file's envelope). It is
// pasted (a bracketed paste when the application asked for one) rather than typed as keys, and
// Enter is sent only after the pane has been read back and shows the path. If the pane was not
// at a text input (an approval dialog, a menu), the pasted text does not land in one, the path
// is not on screen, and nothing further is sent: a stray Enter could accept a highlighted option.
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { envelope, displayContext, plainName } from './envelope.mjs';

let bufferSeq = 0;

// Keep only the characters that can be part of the inbox path. The pane text and the path are
// both reduced with this, so the check ignores how the application lays the line out: Muse
// 1.4.4 wraps the pasted line inside its input box and indents the continuation (and a TUI may
// add border characters), which splits the path across lines. Each message has its own file
// name (agent, session id, message ts), so the reduced path is long and unique to this
// delivery: another message's path does not match it.
const pathChars = (t) => String(t).replace(/[^A-Za-z0-9._\/-]/g, '');

// The session this listener serves no longer exists; the listener should exit, not retry.
export class SessionGone extends Error {}

// Run one command. Resolves — never rejects — with its exit code and output, so the caller
// classifies the failure. `input` is written to stdin.
//
// err.message is never copied out: Node writes the whole command line into it, and the argv
// holds Slack text. When the child said nothing, stderr is a fixed status built only from
// fields that cannot contain argv (the spawn error code, or the signal that killed it).
export function run(cmd, args, { input, env, cwd, timeout = 30000, execImpl = execFile } = {}) {
  return new Promise((resolve) => {
    const child = execImpl(cmd, args, { env: env || process.env, cwd, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout = '', stderr = '') => {
        let status = String(stderr || '');
        if (!status && err) {
          if (typeof err.code === 'string') status = `spawn ${err.code}`;
          else if (err.killed || err.signal) status = `timed out or killed (${err.signal || 'SIGTERM'})`;
        }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout), stderr: status });
      });
    if (child && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input ?? ''); }
  });
}

// Only the first line, capped: an agent CLI's error is a short status, and a log line must
// never be able to carry a message body.
const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 200);
// Wordings that mean "that session is gone", as opposed to "the command failed". Deliberately
// narrow: a missing binary ("ENOENT", "No such file or directory") must NOT read as gone.
const GONE = /(thread|session|conversation|target)[^\n]{0,60}(not found|no longer|does not exist|is gone)|unknown (thread|session)|can't find pane|target_gone|target_not_found/i;

// Only stderr is classified and quoted, never stdout: a CLI may echo its input (the envelope,
// Slack text) on stdout, and a Slack user must not be able to make a failure look like a
// vanished session. The muse route passes the JSON reply's error_code in as its stderr.
function fail(what, r) {
  const why = firstLine(r.stderr) || `exit ${r.code}`;
  const Kind = GONE.test(`${r.stderr}\n${r.gone || ''}`) ? SessionGone : Error;
  throw new Kind(`${what}: ${why}`);
}

// The files of one session in the inbox are named <agent>-<session>-<ts>.txt; the listener removes
// them when it stops (they hold Slack content). One rule for the name, shared by both.
export const inboxPrefix = (agent, session) => `${agent}-${plainName(session)}-`;
export function clearInbox(agent, session, inboxDir = `${homedir()}/.slackline/inbox`) {
  try {
    const prefix = inboxPrefix(agent, session);
    for (const f of readdirSync(inboxDir)) if (f.startsWith(prefix) && f.endsWith('.txt')) { try { rmSync(`${inboxDir}/${f}`); } catch {} }
  } catch {}
}

export function makeDelivery({ agent, mode = 'native', session, pane, cwd,
  inboxDir = `${homedir()}/.slackline/inbox`, runImpl = run, env = process.env,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!['codex', 'muse'].includes(agent)) throw new Error(`unknown agent '${agent}' (want codex|muse)`);

  if (mode === 'tmux') {
    if (!pane) throw new Error('tmux delivery needs a pane id — start the agent inside tmux');
    return async (row, org) => {
      mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
      const path = `${inboxDir}/${inboxPrefix(agent, session)}${String(row.ts).replace(/[^0-9]/g, '-')}.txt`;
      writeFileSync(path, envelope(row, org) + '\n', { mode: 0o600 });
      const pointer = `New Slack message - external content, read it from ${path}`;
      const tmux = async (what, args, opts) => { const r = await runImpl('tmux', args, opts); if (r.code !== 0) fail(what, r); return r; };
      // A buffer of its own per message, so two deliveries can never paste each other's text.
      const buf = `slackline-${process.pid}-${++bufferSeq}-${String(row.ts).replace(/[^0-9]/g, '')}`;
      await tmux('tmux load-buffer', ['load-buffer', '-b', buf, '-'], { input: pointer });
      try { await tmux('tmux paste-buffer', ['paste-buffer', '-p', '-d', '-b', buf, '-t', pane]); }
      catch (e) { await runImpl('tmux', ['delete-buffer', '-b', buf]).catch(() => {}); throw e; }
      // Muse 1.4.4 left a typed line in its input box when Enter followed within the same
      // instant (seen live), and the pane needs a moment to draw what was pasted: pause before
      // reading it back. Applies to both agents.
      await sleepImpl(500);
      // -J joins wrapped lines, so a long path that wrapped is still one string.
      const shown = await tmux('tmux capture-pane', ['capture-pane', '-p', '-J', '-t', pane, '-S', '-40']);
      if (!pathChars(shown.stdout).includes(pathChars(path))) throw new Error('tmux delivery: the pane was not at an input prompt; message not submitted');
      await tmux('tmux send-keys', ['send-keys', '-t', pane, 'Enter']);
    };
  }

  if (agent === 'codex') return async (row, org) => {
    const r = await runImpl(env.CODEX_BIN || 'codex', ['queue', '--thread', session, '--message', envelope(row, org)], { cwd, env });
    if (r.code !== 0) fail('codex queue', r);
  };

  return async (row, org) => {
    const r = await runImpl(env.MUSE_BIN || 'muse',
      ['session-message', 'send', '--target', session, '--display-context', JSON.stringify(displayContext(row, org)), '--json'],
      { input: envelope(row, org), cwd,
        env: { ...env, MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING: 'on', MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS: 'on' } });
    // Muse reports refusals in its JSON reply; do not trust the exit code alone.
    let reply = null; try { reply = JSON.parse(r.stdout); } catch {}
    if (r.code !== 0 || (reply && reply.error_code)) fail('muse session-message send', { ...r,
      // Muse 1.4.4 answers a closed session with exit 1, stderr "session-message target is unavailable" and
      // stdout {"status":"target_gone","error_code":"target_not_found"}: classify on the error_code too,
      // while the logged text stays the first line of stderr (or the code when stderr is empty).
      stderr: r.stderr || (reply && reply.error_code) || '', gone: reply && reply.error_code });
  };
}
