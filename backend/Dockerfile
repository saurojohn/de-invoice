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
# --legacy-peer-deps: pdfkit has a
# peer-dep conflict with
# @signpdf/placeholder-pdfkit (the
# peer wants pdfkit ^1.x but we
# use ^0.15.x — they're API-
# compatible but npm 7+ refuses
# to install). The dev .npmrc
# already pins legacy-peer-deps=true
# but we also pass the flag here
# so `docker build --no-cache`
# doesn't accidentally drop the
# .npmrc and break the build.
RUN npm ci --no-audit --no-fund --legacy-peer-deps

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

# ─── Stage 2b: build ─────────────────────────────────────────────
# Tier 580: the image runs the compiled program. It used to start
# `ts-node --transpile-only src/main.ts`: the TypeScript compiler in the
# production process, every start a compilation, no type check anywhere in
# the image build. Measured on the developer machine: `tsc` builds in 10 s;
# `node dist/main.js` is up in under 3 s with about 330 MB.
# A type error now fails the image build instead of the first request.
FROM dev AS build
RUN npx tsc -p tsconfig.json --incremental false --declaration false
# What runs needs no compiler, linter or test tools.
RUN npm prune --omit=dev --no-audit --no-fund --legacy-peer-deps

# ─── The official XRechnung validator (KoSIT) ──────────────────
# Tier 569. Its files (validator.jar, scenarios.xml, the schema and
# schematron repository — 18 MB, in git under infra/kosit) live outside this
# build context. A builder hands them in as a named context called `kosit`,
# which replaces this empty stage:
#   compose:  build.additional_contexts: { kosit: ../kosit }
#   CLI:      docker build --build-context kosit=infra/kosit backend
# Built without it, the image simply has no validator and the API falls back
# to the in-process check (as it always did in the container).
FROM scratch AS kosit

# ─── Stage 3: runtime ──────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
# Tier 569: a Java runtime for the KoSIT validator (the man directory is
# what the JRE's post-install step expects on a slim image).
RUN mkdir -p /usr/share/man/man1 \
  && apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates openjdk-17-jre-headless \
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
# Tier 580: from the build stage — production dependencies and dist/ (the
# compiled src/; its `__dirname`-relative paths keep their depth).
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=dev --chown=app:app /app/prisma ./prisma
# Tier 559: scripts/baseline-migrations.sh (one-time, for a database that was
# created with `db push`).
COPY --from=dev --chown=app:app /app/scripts ./scripts
# Tier 569: where kosIT-validator.service.ts looks for it — three levels up
# from /app/dist/invoices is /, so /infra/kosit.
COPY --from=kosit / /infra/kosit/

# Tier 654: the program runs as `app`, not as root.
#
# It ran as root because "the named volume comes up root-owned and a non-root
# user can't mkdir inside it". A new named volume takes the owner of the
# directory it is mounted over — so the directory is made here, owned by
# `app`, and the volume comes up as `app`'s. A volume that an earlier image
# left root-owned is handed over by the entrypoint (see there).
RUN mkdir -p /data/invoice-system && chown app:app /data/invoice-system /app
COPY --chown=app:app docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0555 /app/docker-entrypoint.sh
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
# (As `app`, whose node_modules these are; npm's cache goes to /tmp — the
# root filesystem is read-only when the container runs, see the compose file.)
USER app
ENV NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN DATABASE_URL=postgresql://nobody:nobody@127.0.0.1:1/nobody \
    npx prisma generate 2>&1 | tail -2 && rm -rf /tmp/.npm

# Tier 580: the compiled program. --enable-source-maps makes a stack trace
# name the .ts line (the maps are in dist/).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/main.js"]