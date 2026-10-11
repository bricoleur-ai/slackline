// Load ~/.slackline/bridge.env into process.env.
//
// Shared because it has to be identical everywhere: the health check reads config to judge the
// daemon, and the watchdog must pass the SAME credentials down to the process that sends the
// alert. When only one of them loaded it, the watchdog detected a real outage and then could not
// report it — the monitoring failed at exactly the moment it mattered.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export function loadEnvFile(path = `${homedir()}/.slackline/bridge.env`) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    // Never clobber an explicit env var — the caller's intent wins over the file's default.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  return true;
}
