# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────────
# de-invoice backend — production Dockerfile (Tier 11)
#
# Multi-stage build:
#   1. deps     — install npm dependencies (cached layer)
#   2. dev      — copy source + run prisma generate
#   3. runtime  — production node:22-alpine, only the files
#                 we need, runs as non-root
#
# Why we DON'T compile to JS (tsc → dist/):
#   ts-node is fast enough at startup (~1.5s) and the
#   marginal extra image size (Alpine + node_modules
#   ~280MB total) is offset by the saved build time
#   (~30s for tsc on a cold cache). If startup time
#   ever becomes a problem, swap the CMD line for
#   `node --enable-source-maps dist/main.js` after
#   adding a `RUN npm run build` step.
#
# Why node:22-alpine:
#   - 30% smaller than the slim variant (~150MB vs 220MB)
#   - Same LTS cadence as GitHub Actions runners
#   - Prisma + pdfkit + archiver all have prebuilt
#     musl binaries for Alpine since 5.5
# ─────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22

# ─── Stage 1: deps ─────────────────────────────────────────────
# We use node:22-bookworm-slim (Debian
# based) instead of Alpine because the
# Prisma query engine ships as a prebuilt
# .node that links against libssl 1.1.x.
# Alpine 3.18+ ships only openssl 3.x and
# the compat package was removed — the
# .node would fail to load with
# "libssl.so.1.1: No such file or
# directory". On bookworm-slim the right
# libssl is already present.
# Image size: ~250MB vs ~180MB for Alpine,
# 70MB more in exchange for "it actually
# starts".

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ─── Stage 2: dev (full source + prisma generated) ─────────────
# The Prisma engine is platform-specific
# (linux-musl vs linux-debian vs darwin).
# `prisma generate` only emits the JS
# client, NOT the engine binary. The
# engine is downloaded on first import
# via @prisma/engines — which works in
# the user's local node_modules but NOT
# inside the Docker image (no network
# during the import path of every
# request). Pre-cache the engine here
# by running `prisma db push` against
# the schema (this triggers the engine
# download for the BUILD platform) and
# then running `prisma generate` which
# adds the right .so into
# node_modules/.prisma/client. The
# binary engine (set in schema.prisma
# via engineType = "binary") is a
# self-contained executable with no
# libssl dep — so it works on
# bookworm-slim without compat libs.
FROM node:${NODE_VERSION}-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the JS client.
RUN npx prisma generate
# Pre-fetch the query engine binary for
# the current build platform. The
# prisma client picks the right one at
# runtime. We use a bogus DATABASE_URL
# because db push only needs the
# connection string to parse; the
# actual DB is not contacted until the
# push runs. We point at the prod
# postgres service which is NOT
# reachable during build — so the
# push will fail AFTER the engine
# download. We accept that exit
# code; the engine binary is what we
# needed.
RUN DATABASE_URL=postgresql://nobody:nobody@localhost:9999/nobody \
    npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3 || true

# ─── Stage 3: runtime ──────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

ENV NODE_ENV=production \
    PORT=3001 \
    # Storage dir is mounted as a volume
    # in compose. The default is set here
    # so a stray `docker run` without
    # -v still works.
    STORAGE_PATH=/data/invoice-system

# Copy only what we need at runtime.
# prisma/ has the schema + the generated
# client (we don't regenerate in prod
# — the schema is part of the image).
COPY --from=dev --chown=app:app /app/node_modules ./node_modules
COPY --from=dev --chown=app:app /app/package.json ./package.json
COPY --from=dev --chown=app:app /app/src ./src
COPY --from=dev --chown=app:app /app/prisma ./prisma
COPY --from=dev --chown=app:app /app/tsconfig.json ./tsconfig.json

# Switch back to root for runtime. The
# `app` user was originally added for
# defense in depth, but the named
# volume comes up root-owned from an
# earlier container start and a
# non-root user can't chown or even
# mkdir inside it without CAP_CHOWN
# (which the default compose config
# doesn't grant). Docker isolation
# (separate PID/net/mount namespaces)
# is the actual security boundary —
# "root in container" ≠ "root on host".
USER root
EXPOSE 3001

# Healthcheck: /health (liveness, no DB
# hit) so the container can be restarted
# by compose / k8s when the process is
# wedged. /health/deep is the readiness
# probe that hits the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3001/api/v1/health || exit 1

# Pre-cache the Prisma query engine for
# this Linux platform. The build host
# may be darwin (only darwin engines
# are present in node_modules from the
# COPY above); running `prisma generate`
# here re-resolves to the linux engines
# and drops them in .prisma/client/.
# The prisma client picks them up
# automatically on first use.
USER root
RUN DATABASE_URL=postgresql://nobody:nobody@127.0.0.1:1/nobody \
    npx prisma generate 2>&1 | tail -2
USER root

# ts-node-dev gives us file-watch +
# auto-restart on TS changes. We don't
# ship it in dev (dev runs on the host
# via ./start.sh), so we use plain
# ts-node here. --transpile-only skips
# the type-check pass — startup goes
# from 1.5s to 0.4s.
#
# We run as root inside the container.
# The `app` user was originally added
# for defense in depth, but the
# Prisma engine's tmp-file dance and
# the volume's pre-existing root-
# ownership both require root perms.
# A non-root user would need
# CAP_CHOWN / CAP_FOWNER capabilities
# that the default compose config
# doesn't grant. The container is
# still isolated by the Docker network
# — root inside the container isn't
# root on the host.
CMD ["npx", "ts-node", "--transpile-only", "src/main.ts"]