#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# de-invoice manual backup
#
# Run from the host to take a one-off pg_dump backup outside
# the regular schedule. The output is written to /tmp by
# default; pass a directory as $1 to override.
#
# Usage:
#   bash infra/prod/backup.sh                    # → /tmp/de_invoice-YYYY-MM-DD-HHMMSS.sql.gz
#   bash infra/prod/backup.sh /var/backups       # → /var/backups/de_invoice-...
#
# This is a fallback for when the docker backup sidecar is
# not running (e.g. during disaster recovery when the stack
# is down and you only have raw DB access). For normal
# scheduled backups, just rely on the prodrigestivill/
# postgres-backup-local container in docker-compose.yml.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

OUT_DIR="${1:-/tmp}"
TS="$(date +%Y-%m-%d-%H%M%S)"
OUT_FILE="${OUT_DIR}/de_invoice-${TS}.sql.gz"

# Read connection info from .env if present, else use defaults.
ENV_FILE="$(dirname "$0")/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

: "${POSTGRES_USER:=de_invoice}"
: "${POSTGRES_DB:=de_invoice}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required (set in .env or env)}"

CONTAINER="de-invoice-postgres"

# Sanity check the container is running.
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Error: container '${CONTAINER}' is not running." >&2
  echo "Start the stack first: cd $(dirname "$0") && docker compose up -d postgres" >&2
  exit 1
fi

echo "Backing up '${POSTGRES_DB}' from '${CONTAINER}' → '${OUT_FILE}'..."

# pg_dump piped through gzip. -Fc would give a custom-format
# binary dump (smaller, supports parallel restore) but plain
# SQL is easier to grep through when investigating corruption.
# We use plain SQL + gzip here.
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  | gzip -9 > "$OUT_FILE"

echo "Done. Size: $(du -h "$OUT_FILE" | cut -f1)"
echo "Restore with: gunzip -c $OUT_FILE | docker exec -i $CONTAINER psql -U $POSTGRES_USER -d $POSTGRES_DB"