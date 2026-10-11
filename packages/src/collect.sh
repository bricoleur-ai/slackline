#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then echo "→ installing deps (first run)…"; npm install --no-audit --no-fund; npx playwright install chromium; fi
node collector.mjs "$@"
