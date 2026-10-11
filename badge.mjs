// The 🤖 badge marks a post made from a HUMAN's Slack account as agent-written, so people
// reading the channel can tell a message came from an agent, not the person. In app mode the
// bot posts under its own distinct Slack identity, so the badge would be redundant noise.
//
// Split out of mcp.mjs (rather than exported from it) so this is importable without running
// mcp.mjs's top-level bootstrap, which opens a store, connects ingest, and holds a stdio
// transport open — none of which a unit test should trigger just to check badge text.
export function badgeFor(creds, text, noBadge) {
  if (creds.mode === 'app' || noBadge) return text;
  return /^:robot(_face)?:/.test(text || '') ? text : ':robot_face: ' + text;
}
