# HTTP server as UID/GID 10001. Set --read-only at runtime (see compose.yaml).

ARG NODE_IMAGE=node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.test.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY test ./test
# Tests run in the build; the chmod keeps the runtime files world-readable regardless of the build host's umask
# (the runtime stage runs as UID 10001 on root-owned files).
RUN npm run typecheck && npm test && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && chmod -R a+rX /app

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
