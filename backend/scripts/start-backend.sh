#!/bin/bash
# scripts/start-backend.sh — canonical backend starter.
#
# Used by:
#   - The developer running locally (`bash scripts/start-backend.sh`)
#   - The e2e suite (when a test like 20-vat-validation.sh needs to
#     restart the backend with VIES_MOCK=1)
#   - GitHub Actions CI
#
# Why this script exists:
#   `nohup env FOO=bar npx ts-node src/main.ts` does NOT reliably
#   pass FOO to the spawned child on darwin — nohup strips some
#   env vars. We need an explicit wrapper that exports the values
#   and then `exec`s the binary.
#
# Env vars (all optional with sensible defaults):
#   PORT               default 3001
#   FRONTEND_URL       default "http://localhost:3000"
#   VIES_MOCK          default unset (uses real EU VIES)
#   AUTH_RATE_LIMIT_DISABLED — REMOVED in Tier 13. The 5/min
#     throttler is now always enforced; tests use the
#     /tmp/cashbook-e2e-auth.env cache to share the same
#     user/company across the whole suite.
#
# Usage:
#   bash scripts/start-backend.sh                  # default
#   VIES_MOCK=1 bash scripts/start-backend.sh      # with VIES mock
#   FRONTEND_URL=http://localhost:3100 bash scripts/start-backend.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

export PORT="${PORT:-3001}"
# Default FRONTEND_URL allows both common dev ports:
#   - 3000 (SH Leder Website / default Next.js dev)
#   - 3100 (de-invoice Playwright test runner — see
#     frontend/playwright.config.ts)
# Tests that need additional origins (e.g. a staging
# server) can set FRONTEND_URL before invoking this script.
# Comma-separated, like the cors library expects.
export FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000,http://localhost:3100}"
export VIES_MOCK="${VIES_MOCK:-}"
# AUTH_RATE_LIMIT_DISABLED intentionally NOT exported here.
# If a developer needs it, they should set it explicitly:
#   AUTH_RATE_LIMIT_DISABLED=1 bash scripts/start-backend.sh
# — and the absence of a default in this script is a small
# forcing function to think twice before disabling it.

# Tier 300: also honor THROTTLE_DISABLED=1 for dev work.
# The NestJS throttler (600 req / 60s by default) is tuned
# for production. In dev, HMR + React strict mode + the
# user opening multiple tabs accumulates 600+ requests in
# under a minute, which trips the 429 on legitimate
# navigation. Same precedence rule as
# AUTH_RATE_LIMIT_DISABLED — never set this in production.
# Use:
#   THROTTLE_DISABLED=1 bash scripts/start-backend.sh
# Verify with:
#   curl -i http://localhost:3001/api/v1/health | head -3
# (no X-RateLimit-Limit / -Remaining headers when disabled).
export THROTTLE_DISABLED="${THROTTLE_DISABLED:-}"

exec npx ts-node src/main.ts
