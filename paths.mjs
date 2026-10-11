// Default on-disk locations.
//
// These live under $HOME, never the current working directory. slackline is usually
// run from inside another project (an MCP server launched by an agent, say), and a
// cwd-relative default meant the sqlite store — which holds Slack tokens and message
// content — landed in whatever repo happened to be open. Two of those files have been
// found sitting in unrelated checkouts.
//
// Override either with SLACKLINE_DB_PATH / SLACKLINE_BLOB_DIR.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDir = () => process.env.SLACKLINE_STATE_DIR || join(homedir(), '.slackline');
export const defaultDbPath = () => process.env.SLACKLINE_DB_PATH || join(stateDir(), 'slackline.db');
export const defaultBlobDir = () => process.env.SLACKLINE_BLOB_DIR || join(stateDir(), 'blobs');
