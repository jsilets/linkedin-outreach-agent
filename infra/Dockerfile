# The single app image.
#
# One container runs two Node processes (see infra/entrypoint.sh): the @loa/runtime
# worker (control-plane brain + in-process browser executor + dispatch tick, MCP
# on MCP_PORT) and the @loa/web server (UI + JSON API, the public face on PORT).
# They share this container's /data volume, COOKIE_VAULT_KEY and DATABASE_URL, so
# an account linked through the web UI is sealed into the same vault the executor
# reads. Keeping them in one service is deliberate: a persistent volume attaches
# to a single service, and the vault must be shared.
#
# RAM expectation: the runtime alone is small (a few hundred MB). Budget ~2GB
# with LOA_EXECUTOR=real, since one headful Chromium plus the runtime fits
# there. Xvfb plus a headful Chromium are installed and the entrypoint starts
# the virtual display, so real browser runs work out of the box.
#
# Nothing sensitive is baked in. DATABASE_URL, ANTHROPIC_API_KEY, LOA_LLM_MODEL,
# COOKIE_VAULT_KEY, MCP_PORT and the PROXY_* vars all arrive at runtime from the
# environment / host secrets.

# ---- build stage ---------------------------------------------------------
# Build the whole workspace once (tsc -b resolves project references), then copy
# the built output plus node_modules into the runtime stage. Node 24 matches
# "engines": { "node": ">=24" }.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Copy the lockfile and every workspace package.json first so `npm ci` layers
# cache on dependency changes, not on every source edit.
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY account-runner/package.json account-runner/
COPY runtime/package.json runtime/
COPY infra/package.json infra/
COPY control-plane/mcp/package.json control-plane/mcp/
COPY control-plane/orchestrator/package.json control-plane/orchestrator/
COPY control-plane/scheduler/package.json control-plane/scheduler/
COPY control-plane/agent/package.json control-plane/agent/
COPY web/package.json web/

# Skip patchright/playwright's browser download during install. The runtime
# stage installs the system Chromium and its OS deps via the patchright CLI.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# Copy the rest of the sources and build the whole workspace. `npm run build`
# runs `tsc -b`, which walks the project references and emits every dist/. The
# web package is not in the root tsc project references, so build its client
# bundle (Vite) separately; the web server itself runs from source via tsx.
COPY . .
RUN npm run build \
 && npm --prefix web run build

# ---- runtime stage -------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Xvfb + xdpyinfo give the virtual display for headful Chromium; dumb-init reaps
# the child processes Chromium spawns and forwards signals. The rest of
# Chromium's runtime libraries are pulled in below by the patchright installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb \
      x11-utils \
      dumb-init \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Bring in the built workspace and its node_modules from the build stage. We
# keep the full node_modules (including devDependencies) on purpose: drizzle-kit
# lives there and the migrate step (npm run db:migrate) needs it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

# Every workspace's package.json + built dist. The runtime resolves the @loa/*
# packages through these.
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/account-runner/package.json ./account-runner/package.json
COPY --from=build /app/account-runner/dist ./account-runner/dist
COPY --from=build /app/runtime/package.json ./runtime/package.json
COPY --from=build /app/runtime/dist ./runtime/dist
COPY --from=build /app/infra/package.json ./infra/package.json
COPY --from=build /app/infra/dist ./infra/dist
COPY --from=build /app/control-plane/mcp/package.json ./control-plane/mcp/package.json
COPY --from=build /app/control-plane/mcp/dist ./control-plane/mcp/dist
COPY --from=build /app/control-plane/orchestrator/package.json ./control-plane/orchestrator/package.json
COPY --from=build /app/control-plane/orchestrator/dist ./control-plane/orchestrator/dist
COPY --from=build /app/control-plane/scheduler/package.json ./control-plane/scheduler/package.json
COPY --from=build /app/control-plane/scheduler/dist ./control-plane/scheduler/dist
COPY --from=build /app/control-plane/agent/package.json ./control-plane/agent/package.json
COPY --from=build /app/control-plane/agent/dist ./control-plane/agent/dist
COPY --from=build /app/control-plane/safety/package.json ./control-plane/safety/package.json
COPY --from=build /app/control-plane/safety/dist ./control-plane/safety/dist

# Migrations ship with the image so `npm run db:migrate` can apply them.
COPY --from=build /app/infra/migrations ./infra/migrations

# The web UI + JSON API run in the same container as the public face (port 8080),
# sharing the /data vault + COOKIE_VAULT_KEY + DATABASE_URL with the runtime. The
# server runs from source via tsx (already in node_modules); the client is the
# prebuilt Vite bundle. node_modules/@loa/web symlinks to this web/ dir.
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/tsconfig.json ./web/tsconfig.json
COPY --from=build /app/web/server ./web/server
COPY --from=build /app/web/client/dist ./web/client/dist

# Install the Chromium build patchright drives, plus its OS deps. patchright is
# the driver the account-runner actually uses (a Playwright drop-in); install
# its Chromium so the driver and the browser stay version-matched. Store the
# browsers in a system path readable by the non-root user.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN node node_modules/patchright/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# gosu lets the entrypoint drop from root to the app user AFTER it fixes runtime
# volume ownership. Platforms mount the /data volume root-owned, which masks the
# build-time chown below, so the fix has to happen at container start as root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

# Entrypoint starts Xvfb, then execs `node runtime/dist/main.js`.
COPY infra/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Non-root user. Create the profile + vault mount points so a first boot without
# a mounted volume still works, and hand them plus the browser cache to that
# user. The container starts as root (no USER line): the entrypoint re-chowns the
# mounted /data volume, then drops to this user via gosu.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 app \
 && mkdir -p /data/profile /data/vault \
 && chown -R app:app /data /opt/playwright-browsers

# The browser profile lives on the mounted volume so cookies/session survive
# restarts. LOA_PROFILE_DIR points the persistent browser context at it.
ENV LOA_PROFILE_DIR=/data/profile

# Ports: the web UI + API (public face) binds PORT; the runtime's MCP server
# binds MCP_PORT internally. The platform routes its domain to PORT (8080) and
# health-checks /healthz there. The host may inject its own PORT at runtime.
ENV PORT=8080
ENV MCP_PORT=8090
EXPOSE 8080

# dumb-init reaps zombies and forwards signals to the entrypoint so container
# stop is clean; the entrypoint execs Node so SIGTERM reaches it directly.
ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/entrypoint.sh"]
