# One image, one Railway service. Web and workers are the same code; ROLES picks
# which of them this container runs.
FROM oven/bun:1.4.0-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY packages/adapters/package.json packages/adapters/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/enrichers/package.json packages/enrichers/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/notify/package.json packages/notify/
COPY packages/payments/package.json packages/payments/
COPY packages/premium/package.json packages/premium/
COPY packages/queue/package.json packages/queue/
RUN bun install --frozen-lockfile || bun install

FROM base AS runtime
ENV NODE_ENV=production
# `ntsb-accidents` reads a 558 MB Microsoft Access database out of a zip,
# because the NTSB publishes no working API. mdbtools turns that into NDJSON.
# Nothing else in the image needs either, and both are a few hundred kilobytes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends mdbtools unzip \
 && rm -rf /var/lib/apt/lists/*
# Bun's isolated linker keeps each workspace's node_modules beside it, so the
# whole deps stage comes across rather than only /app/node_modules.
COPY --from=deps /app /app
COPY . .
RUN bun apps/web/build-client.js

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "apps/web/src/main.js"]
