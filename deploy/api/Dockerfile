# Context: repository root. Version and multi-platform digest verified in Docker Hub.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile
COPY apps/api/src ./apps/api/src
COPY packages/contracts/src ./packages/contracts/src
COPY packages/db/src ./packages/db/src
RUN bun build apps/api/src/index.ts --target=bun --outdir /app/dist

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=build --chown=bun:bun /app/dist/index.js ./index.js
USER bun
EXPOSE 3001
# index.ts reads Railway's PORT and handles SIGTERM. Migrations are operator-run.
CMD ["bun", "index.js"]
