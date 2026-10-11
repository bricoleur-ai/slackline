# Contributing

Thanks for taking a look. This is a small project; issues and pull requests are
both welcome.

## Getting set up

```bash
git clone https://github.com/bricoleur-ai/slackline.git
cd slackline
npm install
npm test
```

Node 22.13 or newer is required — the SQLite backend uses the built-in `node:sqlite`
module, so there are no native build steps.

## Running the tests

```bash
npm test          # the full suite (node --test)
node --test test/keys.test.mjs   # a single file
```

Tests use temporary directories and an in-memory or temp-file store; they do not
need Slack credentials and do not talk to the network. A test that needs real
Slack access belongs under `test/live/` and must be skipped by default.

## Pull requests

- Keep changes focused; a PR that does one thing is easier to review than one that
  does four.
- Add a test when you fix a bug — the test should fail before your fix.
- Do not commit credentials, workspace identifiers, channel IDs, or host names.
  Use neutral placeholders (`acme`, `C0EXAMPLE01`, `hub.example.com`).
- Run `npm test` before opening the PR.

## Reporting security issues

Please do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
