#!/usr/bin/env bash
# Build downloadable collector packages for macOS / Linux / Windows.
set -e
cd "$(dirname "$0")"
SRC=src; DIST=dist; mkdir -p "$DIST"; rm -f "$DIST"/*.zip
for OS in macos linux windows; do
  STAGE="$(mktemp -d)/slackline-collector"
  mkdir -p "$STAGE"
  cp "$SRC/collector.mjs" "$SRC/package.json" "$STAGE/"
  if [ "$OS" = "windows" ]; then cp "$SRC/collect.bat" "$STAGE/"; RUN="collect.bat --hub <URL> --secret <SECRET>"; else cp "$SRC/collect.sh" "$STAGE/"; RUN="./collect.sh --hub <URL> --secret <SECRET>"; fi
  cat > "$STAGE/INSTALL.txt" <<TXT
slackline collector ($OS)

Prereq: Node.js 18+ installed (https://nodejs.org).

1. Unzip this folder anywhere.
2. In a terminal, from inside the folder, run:
     $RUN
   (the hub URL + shared secret are on the slackline install page)
3. A browser opens — sign in to your Slack workspace once.
4. It captures your session and pushes it to the hub. Done.

Re-run the same command any time to refresh a rotated session.
First run installs dependencies (Node packages + a headless Chromium); later runs are instant.
Your token/cookie go ONLY to your hub over the shared secret — nothing else leaves the machine.
TXT
  ( cd "$(dirname "$STAGE")" && zip -qr "$OLDPWD/$DIST/slackline-collector-$OS.zip" slackline-collector )
  echo "built $DIST/slackline-collector-$OS.zip"
done
