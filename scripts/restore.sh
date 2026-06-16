#!/bin/bash
# restore.sh — restore a backup taken by backup.sh
#
# Usage:
#   scripts/restore.sh                          # latest backup
#   scripts/restore.sh 2026-06-16-195250        # specific timestamp
#   scripts/restore.sh 2026-06-16               # latest run of that day
#
# What it does:
#   1. Looks up the matching backup dir under
#      $BACKUP_ROOT
#   2. Confirms with the user (must type "yes")
#   3. Drops + recreates the de_invoice DB
#   4. pg_restore's the dump
#   5. Extracts the attachments tar over the
#      storage dir
#   6. Prints a one-line summary so the user
#      can verify the restore worked
#
# Why drop + recreate: pg_restore --clean is
# unreliable for heavily-schema-drifted databases
# (the test data accumulates FK constraints over
# months of development). A clean slate is the
# only restore that's guaranteed to work.

set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/data/backups/de-invoice}"
BACKUP_DB_USER="${BACKUP_DB_USER:-de_invoice}"
BACKUP_DB_NAME="${BACKUP_DB_NAME:-de_invoice}"
ATTACHMENT_PATH="${ATTACHMENT_PATH:-$HOME/data/invoice-system}"
PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"

SELECTED="${1:-}"

# ─── Pick the backup dir ──────────────────────────────────
if [[ -z "$SELECTED" ]]; then
  # Default: most recent
  BACKUP_DIR=$(ls -1dt "$BACKUP_ROOT"/backup-* 2>/dev/null | head -1)
  if [[ -z "$BACKUP_DIR" ]]; then
    echo "No backups found in $BACKUP_ROOT" >&2
    exit 1
  fi
elif [[ -d "$BACKUP_ROOT/backup-$SELECTED" ]]; then
  # Exact timestamp match
  BACKUP_DIR="$BACKUP_ROOT/backup-$SELECTED"
else
  # Day prefix — pick the latest run of that day
  BACKUP_DIR=$(ls -1dt "$BACKUP_ROOT"/backup-${SELECTED}-* 2>/dev/null | head -1)
  if [[ -z "$BACKUP_DIR" ]]; then
    echo "No backup matching '$SELECTED' in $BACKUP_ROOT" >&2
    exit 1
  fi
fi

DB_FILE="$BACKUP_DIR/db.sql.gz"
ATT_FILE="$BACKUP_DIR/attachments.tar.gz"

if [[ ! -f "$DB_FILE" ]]; then
  echo "DB dump missing: $DB_FILE" >&2
  exit 1
fi

echo "Will restore from: $BACKUP_DIR"
echo "  DB:        $(du -h "$DB_FILE" | awk '{print $1}')"
if [[ -f "$ATT_FILE" ]]; then
  echo "  Attachments: $(du -h "$ATT_FILE" | awk '{print $1}')"
fi
echo
echo "⚠ This will REPLACE the current database and attachments."
echo "  The current $BACKUP_DB_NAME DB and the current $ATTACHMENT_PATH"
echo "  directory will be OVERWRITTEN."
echo
read -p "Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# ─── Restore the DB ───────────────────────────────────────
echo "Dropping + recreating database…"
docker exec "$PG_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres -c \
  "DROP DATABASE IF EXISTS $BACKUP_DB_NAME;" >/dev/null
docker exec "$PG_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres -c \
  "CREATE DATABASE $BACKUP_DB_NAME;" >/dev/null

echo "Restoring DB…"
# pg_restore inside the container — same version
# as the dump, no host port issues.
docker exec -i "$PG_CONTAINER" pg_restore \
  -U "$BACKUP_DB_USER" \
  -d "$BACKUP_DB_NAME" \
  --no-owner \
  --no-privileges \
  --jobs=2 \
  < "$DB_FILE"

# ─── Restore attachments ──────────────────────────────────
if [[ -f "$ATT_FILE" ]]; then
  echo "Restoring attachments…"
  # Back up the current attachments dir before we
  # overwrite it. The user is restoring to a
  # specific point in time, so a "current" copy
  # in case the restore is wrong is a safety net.
  if [[ -d "$ATTACHMENT_PATH" ]]; then
    mv "$ATTACHMENT_PATH" "${ATTACHMENT_PATH}.pre-restore-$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$(dirname "$ATTACHMENT_PATH")"
  tar -xzf "$ATT_FILE" -C "$(dirname "$ATTACHMENT_PATH")"
  echo "Attachments restored from archive."
fi

echo
echo "Restore complete. Verify with: ./start.sh + dashboard login."
