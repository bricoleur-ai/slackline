FROM node:22-alpine

# Links this image to its source repo on GHCR, so the package inherits the repo's
# access control instead of defaulting to a separate, unrelated permission set.
LABEL org.opencontainers.image.source="https://github.com/bricoleur-ai/slackline" \
      org.opencontainers.image.description="slackline — live Slack context layer for AI agents"

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the whole source tree; .dockerignore decides what is excluded. Do NOT go back to
# enumerating `COPY *.mjs` — that form silently omits subdirectories, and the image then fails
# at runtime with "Cannot find module './stores/postgres.mjs'" rather than at build time.
COPY . .

# node:22-alpine ships an unprivileged `node` user (uid 1000) for exactly this purpose — run as
# it rather than root. chown happens before the switch so bind-mounted-at-runtime dirs (blobs)
# start out writable; a fresh named volume mounted over /app/blobs inherits this ownership from
# the image on first creation.
RUN apk add --no-cache bash zip \
 && bash packages/build.sh \
 && mkdir -p /app/blobs \
 && chown -R node:node /app
USER node

# Fail the BUILD if the module graph is broken, so a packaging mistake can never reach a
# container that looks healthy until the first request touches the missing file.
RUN node -e "import('./db.mjs').then(()=>import('./ingest.mjs')).then(()=>import('./api.mjs')).then(()=>console.log('module graph ok')).catch(e=>{console.error('BROKEN IMAGE:',e.message);process.exit(1)})"

EXPOSE 8790
CMD ["node", "server.mjs"]
