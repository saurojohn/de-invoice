# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────────
# de-invoice frontend — production Dockerfile (Tier 11)
#
# Multi-stage build:
#   1. deps     — install npm dependencies
#   2. builder  — run `next build` (produces
#                 .next/standalone for runtime)
#   3. runtime  — copy just the standalone
#                 bundle + public + .next/static
#
# Why standalone output:
#   `output: "standalone"` in next.config.ts
#   tells Next.js to emit a minimal
#   server.js in .next/standalone that
#   includes ONLY the files needed at
#   runtime (no node_modules tree, no
#   dev tooling). The trace analyser
#   follows imports back from server
#   components and includes exactly
#   what's used. The result is a
#   ~30-40MB image instead of the
#   400MB+ of a vanilla Next.js
#   production image.
#
# The COPY of public/ + .next/static is
# required because standalone doesn't
# bundle static assets (they're served
# as files at runtime, not imported).
# ─────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22

# We use node:22-bookworm-slim (Debian) for
# the same reason as the backend Dockerfile:
# consistent libssl ABI with the prebuilt
# .node binaries (Prisma engine on backend,
# Next.js native image optimizers here).

# ─── Stage 1: deps ─────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ─── Stage 2: builder ──────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Tier 363: `next build` inlines NEXT_PUBLIC_* into the client bundle, so the
# browser-side API base has to exist at BUILD time. Without this ARG the
# compose files' runtime `environment:` value never reached the bundle and
# src/lib/api.ts fell back to http://localhost:3001 — every browser would
# have called its own machine. Refuse to build without it rather than bake
# that fallback into a production image. Use the public origin the reverse
# proxy serves (it routes /api/ to the backend), e.g. https://example.com.
ARG NEXT_PUBLIC_API_URL
RUN if [ -z "$NEXT_PUBLIC_API_URL" ]; then \
      echo "ERROR: build arg NEXT_PUBLIC_API_URL is required (public URL, e.g. https://example.com)" >&2; \
      exit 1; \
    fi
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# ─── Stage 3: runtime ──────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Copy the standalone server (Node bundle
# with only the files Next determined are
# needed at runtime).
COPY --from=builder --chown=app:app /app/.next/standalone ./
# Static assets + public files are served
# as files at runtime, not bundled.
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

USER app
EXPOSE 3000

# Liveness check — Next.js exposes a
# streaming response on /api/health
# (we don't have one yet; using the
# root / which returns the React tree).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]