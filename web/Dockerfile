# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# The API uses Node's built-in SQLite; exported pages need no npm runtime packages.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    WEB_PORT=3000 \
    DIVIDEND_DATABASE=/data/diviwish.sqlite3
COPY --from=build /app/out ./out
COPY package.json ./
COPY scripts/preview.mjs scripts/local-server.mjs scripts/local-database.mjs scripts/runtime-config.mjs ./scripts/
COPY worker ./worker
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.WEB_PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "scripts/preview.mjs"]
