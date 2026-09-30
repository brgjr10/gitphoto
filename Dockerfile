# Chromium needs a larger /dev/shm than the 64 MB default, which the compose
# file provides via shm_size. --no-sandbox is required because the container
# runs without user-namespace privileges.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    PORT=9780

# git is not optional: every render starts with a shallow clone.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Fonts are vendored so the rendered PNG does not depend on the host's font set.
COPY scripts/fetch-fonts.mjs scripts/fetch-fonts.mjs
RUN node scripts/fetch-fonts.mjs || echo "font fetch failed; banner will use the system stack"

# Browser download needs the Playwright CLI, which --ignore-scripts skipped.
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY public ./public
COPY assets ./assets
COPY .env.example ./

RUN mkdir -p /data && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 9780

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "src/server.js"]
