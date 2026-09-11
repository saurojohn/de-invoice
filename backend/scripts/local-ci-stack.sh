#!/usr/bin/env bash
# local-ci-stack.sh — bring up a throwaway stack that matches the CI `e2e`
# job, so a local backend e2e run is comparable to CI.
#
# Tier 357. Until now this was typed by hand for every local verification,
# and the hand-typed versions kept drifting from CI: skipping the search_tsv
# raw-SQL migration (41-migrate, 60-tier28-search and 95-tier68-global-search
# then fail), leaving STORAGE_PATH unset (42-backup-fire-drill then archives
# ~/data/invoice-system), and omitting NODE_ENV / SMTP_HOST /
# FINTS_PIN_ENC_KEY. Every step below mirrors .github/workflows/ci.yml; if
# that job changes, change this too.
#
# Usage:
#   bash scripts/local-ci-stack.sh up            # fresh DB + schema + backend + seed
#   bash scripts/local-ci-stack.sh run           # `up`, then e2e/run-all.sh in the same env
#   bash scripts/local-ci-stack.sh down          # stop backend, remove the container
#
# Env overrides: PG_CONTAINER (default tmp-ci-pg), PG_PORT (default 55460).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export PG_CONTAINER="${PG_CONTAINER:-tmp-ci-pg}"
PG_PORT="${PG_PORT:-55460}"

# `up` does `docker rm -f "$PG_CONTAINER"`. The real dev container is
# bind-mounted to /tmp/pgdata and holds the developer's data (see
# scripts/fix-dev-pg.sh), so never let this script target it.
if [ "$PG_CONTAINER" = "de-invoice-postgres" ]; then
  echo "FATAL: refusing to recreate de-invoice-postgres (the dev database)." >&2
  echo "       Pick a throwaway name, e.g. PG_CONTAINER=tmp-ci-pg." >&2
  exit 2
fi

# Same values as the CI e2e job's env block + the inline env of its
# "Start backend" step. The FinTS key is CI's public fixture, not a secret.
export DATABASE_URL="postgresql://de_invoice:de_invoice_pass@localhost:${PG_PORT}/de_invoice?schema=public"
export NODE_ENV=test
export SMTP_HOST=""
export STORAGE_PATH=/tmp/de-invoice-storage
# scripts/backup.sh archives ATTACHMENT_PATH, which defaults to
# ~/data/invoice-system. CI has no such directory; locally it is the
# developer's real attachment store, and e2e/42-backup-fire-drill.sh would
# copy all of it into /tmp on every run. Point it at the test storage.
export ATTACHMENT_PATH="$STORAGE_PATH"
# The fire-drill spec's host pg_dump fallback uses this port.
export BACKUP_DB_PORT="$PG_PORT"
export VIES_MOCK=1
export EXCHANGE_RATES_MOCK=1
export THROTTLE_DISABLED=1
export FINTS_PIN_ENC_KEY="ci-fixture-key-do-not-use-in-prod-00000000000000000000"
export API="http://localhost:3001"

stop_backend() {
  pkill -f "ts-node src/main.ts" 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -f "ts-node src/main.ts" >/dev/null || return 0
    sleep 0.5
  done
  pkill -9 -f "ts-node src/main.ts" 2>/dev/null || true
}

up() {
  echo "▶ fresh postgres:16 as '$PG_CONTAINER' on :$PG_PORT"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER=de_invoice -e POSTGRES_PASSWORD=de_invoice_pass -e POSTGRES_DB=de_invoice \
    -p "${PG_PORT}:5432" postgres:16 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$PG_CONTAINER" pg_isready -q -U de_invoice 2>/dev/null && break
    sleep 1
  done

  cd "$BACKEND_DIR"
  echo "▶ schema (CI 'Apply prisma schema' step)"
  npx prisma db push --accept-data-loss --skip-generate >/dev/null
  cat prisma/migrations/20260701000001_search_tsv/migration.sql \
    | npx prisma db execute --stdin --schema prisma/schema.prisma >/dev/null
  TABLE_COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
  if [ "${TABLE_COUNT:-0}" -lt 62 ]; then
    echo "FATAL: only $TABLE_COUNT tables (expected >= 62)" >&2; exit 1
  fi
  echo "  tables: $TABLE_COUNT"

  echo "▶ backend (via scripts/start-backend.sh, as e2e spec 20 restarts it)"
  mkdir -p "$STORAGE_PATH"
  stop_backend
  nohup bash scripts/start-backend.sh > /tmp/local-ci-backend.log 2>&1 &
  H=000
  for _ in $(seq 1 90); do
    H=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/health" 2>/dev/null || true)
    [ "$H" = "200" ] && break
    sleep 1
  done
  if [ "$H" != "200" ]; then
    echo "FATAL: backend not healthy (last status $H); see /tmp/local-ci-backend.log" >&2
    tail -20 /tmp/local-ci-backend.log >&2; exit 1
  fi
  echo "  backend healthy"

  echo "▶ seed (CI 'Seed test data' step)"
  bash e2e/ci-seed.sh >/tmp/local-ci-seed.log 2>&1 || {
    echo "FATAL: ci-seed.sh failed; see /tmp/local-ci-seed.log" >&2; tail -20 /tmp/local-ci-seed.log >&2; exit 1; }
  echo "  seeded"
}

case "${1:-}" in
  up)   up ;;
  run)  up; cd "$BACKEND_DIR/e2e"; SEGMENT_SIZE=20 SEGMENT_SLEEP=10 bash run-all.sh ;;
  down) stop_backend; docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; echo "down" ;;
  *)    sed -n '2,19p' "$0"; exit 1 ;;
esac
