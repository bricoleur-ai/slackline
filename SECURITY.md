# Security Policy

slackline holds Slack credentials and message content, so please report security
issues privately rather than in a public issue.

**How to report:** open a [private security advisory](../../security/advisories/new)
on this repository. If that is unavailable to you, open an issue containing only
"security report, please contact me" and no details, and a maintainer will reply
with a private channel.

Please include what you can reproduce, the impact, and the affected version or
commit. We aim to acknowledge within a few days.

## Handling credentials

- Slack tokens live outside the repository, in `~/.slackline/` (or a path you set).
  Nothing in this project should ever write a credential into the working tree.
- `.gitignore` and `.dockerignore` both exclude `.slackline/`. If you add a new
  credential path, add it to **both** — a token committed to an image layer is as
  exposed as one committed to git.
- The hub's shared secret (`SLACKLINE_SECRET`) and issued keys grant read access to
  everything the connected Slack account can see. Treat them like passwords.
