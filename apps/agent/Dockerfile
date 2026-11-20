# The manager and its team. Built from the repo root:
#   flyctl deploy . --config apps/agent/fly.toml --dockerfile apps/agent/Dockerfile --remote-only
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# A bold font with Latin and Cyrillic, and fontconfig for libass, for the words in the videos Quest makes
# (infra/ffmpeg-video.ts); ffmpeg itself comes with the dependencies (ffmpeg-static).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*

# Manifests first, so dependencies stay cached while the source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY apps/agent/package.json apps/agent/
COPY apps/extension/package.json apps/extension/
RUN npm ci --omit=dev --workspace @mq/agent --include-workspace-root=false && npm cache clean --force

COPY packages/core/src packages/core/src
COPY packages/i18n/src packages/i18n/src
COPY apps/agent/public apps/agent/public
COPY apps/agent/src apps/agent/src
# The landing's faces, Visor and zip dialog, for the Chrome setup pages (http/server.ts).
COPY apps/web/public/fonts apps/web/public/fonts
COPY apps/web/public/quest.svg apps/web/public/install.js apps/web/public/

# TypeScript runs as-is: Node strips the types (no build step, see CLAUDE.md).
RUN node --experimental-strip-types --disable-warning=ExperimentalWarning -e "0"

# The entrypoint starts as root, opens Fly's API socket to the node group (the
# agent suspends its own machine through it), then runs the agent as `node`.
COPY --chmod=755 apps/agent/entrypoint.sh /usr/local/bin/mq-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/mq-entrypoint"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "apps/agent/src/main.ts"]
