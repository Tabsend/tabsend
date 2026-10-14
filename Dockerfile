# syntax=docker/dockerfile:1
#
# Tabsend relay — multi-stage, non-root. Build context is the repo ROOT (the server
# depends on the @tabsend/shared workspace package). See docs/DEPLOY.md for the full
# self-host story (env vars, Postgres, HTTPS, backups).
#
#   docker build -t tabsend-relay .
#   docker run -p 8787:8787 -v tabsend-data:/data \
#     -e VAPID_SUBJECT=mailto:you@example.com \
#     tabsend-relay
#
# VAPID keys are generated on first boot and persist in the relay database under /data.
# A complete VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY pair remains an optional explicit override.
#
# The base image must satisfy the repo's engines (node >= 26). The relay runs via tsx
# (esbuild-backed) straight from source — there is no separate JS compile step.

# ---- build: install server + shared + deps (native better-sqlite3 compiles here) ----
FROM node:26-bookworm-slim AS build
WORKDIR /app
# Toolchain in case a native module (better-sqlite3) has no prebuilt for this Node ABI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# pnpm. NOT via corepack: Node 26's images no longer ship it, so `corepack enable`
# dies with "corepack: not found". Install the exact version package.json pins in its
# `packageManager` field instead — never pnpm@latest, or a lockfile written by another
# pnpm could start failing --frozen-lockfile out of nowhere. Keep this in sync with
# package.json; server/test/dockerfile.test.ts fails the build if the two drift apart.
ARG PNPM_VERSION=11.13.1
RUN npm install --global pnpm@${PNPM_VERSION}
# Copy the whole (dockerignored) source tree, then a filtered, frozen install: only the
# server and its workspace dependency (shared), keeping dev deps because tsx (the runner)
# is one. `...` pulls in the workspace deps of @tabsend/server.
COPY . .
RUN pnpm install --frozen-lockfile --filter @tabsend/server...

# ---- runtime: copy the built tree, drop privileges ----
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_URL=sqlite:/data/tabsend.db \
    TLS_DIR=/data/tls
WORKDIR /app
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin tabsend \
    && mkdir -p /data && chown tabsend:tabsend /data
COPY --from=build --chown=tabsend:tabsend /app /app
USER tabsend
EXPOSE 8787
VOLUME ["/data"]
# Healthcheck hits the unauthenticated discovery route (no secrets, always available).
# The scheme follows TLS_SELF_SIGNED, since in that mode the relay serves https on the
# same port. Certificate verification is off for the probe only — it is a loopback call
# to ourselves, and the cert is self-signed by design (clients pin it instead; ADR-0019).
#
# The interval is also the deploy's readiness resolution: `docker compose up --wait`
# blocks until this reports healthy, and Docker runs the first check one interval in.
# The relay answers about three seconds after start, so a 30s interval would have a
# deploy sit there for half a minute after the relay was already serving.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "const s=(process.env.TLS_SELF_SIGNED==='1'||process.env.TLS_SELF_SIGNED==='true')?'https':'http';fetch(s+'://127.0.0.1:'+(process.env.PORT||8787)+'/v1/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run tsx directly (not `pnpm start`) so the container start never triggers pnpm's
# deps-status check (which would attempt an install). tsx is not hoisted to the root
# node_modules under pnpm's isolated linker, so use the server package's local bin.
CMD ["server/node_modules/.bin/tsx", "server/src/server.ts"]
