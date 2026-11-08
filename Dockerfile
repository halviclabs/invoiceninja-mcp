# syntax=docker/dockerfile:1
# invoiceninja-mcp container image: the streamable-HTTP server on port 8787, as UID/GID 10001 with a read-only root
# filesystem. ALVIREQ runs it as a sidecar next to each instance: the chart passes the bearer, and every request
# carries the connection's Invoice Ninja credentials (INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS).

ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
# World-readable regardless of the build host's umask: the runtime stage runs as UID 10001 on root-owned files.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && chmod -R a+rX /app

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
# npm, npx, corepack and yarn are removed: the image only runs node, and they add findings to the image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --gid 10001 mcp \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mcp
COPY --from=build --chown=0:0 /app/package.json ./package.json
COPY --from=build --chown=0:0 /app/node_modules ./node_modules
COPY --from=build --chown=0:0 /app/dist ./dist
USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/http.js"]
