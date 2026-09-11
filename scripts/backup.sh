#!/bin/bash
# backup.sh — PostgreSQL + attachments backup with rotation
#
# Tier 14. Why this exists:
#   - docker-compose volume `postgres_data` is the
#     ONLY copy of all GoBD-relevant data. A stray
#     `docker volume rm` = 100% data loss.
#   - Receipts (Tier 12 attachments) live on disk at
#     ~/data/invoice-system/. They are NOT in the
#     database — only the Attachment row + storage
#     path. So a DB backup alone loses the Beleg
#     files. GoBD §147 AO requires the originals
#     to be retrievable for 10 years.
#
# What this script does:
#   1. pg_dump the database (custom format, compressed)
#   2. Tar+gzip the attachments directory
#   3. Stage both into a timestamped dir under
#      $BACKUP_ROOT
#   4. Run rotation: keep the 7 most-recent daily
#      backups + 4 most-recent weekly + everything
#      from the current month (the "monthly anchor")
#   5. Optionally upload to S3 if $BACKUP_S3_BUCKET
#      is set (skipped by default — local-only is
#      the safe default for a single-machine setup)
#
# Restoring:
#   pg_restore -d de_invoice -c backup-YYYY-MM-DD.sql.gz
#   tar xzf backup-YYYY-MM-DD-attachments.tar.gz -C /
#
# Why we DON'T use pg_basebackup / WAL streaming:
#   That's for HA clusters with a separate backup
#   host. For a single-machine deployment, daily
#   pg_dump is the right tool — the dump window is
#   ~30s for a 1GB DB, the downtime is negligible,
#   and the restore is a single command.
#
# Exit codes:
#   0 = backup succeeded
#   1 = at least one stage failed (DB or attachments)
#   2 = required tools missing (pg_dump, tar)
#   We always try both stages even if one fails —
#   a partial backup is better than no backup.

set -uo pipefail

# ─── Config ────────────────────────────────────────────────
# All defaults are dev-friendly. Override via env
# vars in production. The rotation policy is
# conservative (7 daily / 4 weekly / monthly anchors)
# but the actual disk usage is tiny — a typical
# daily backup is ~5MB compressed.
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/data/backups/de-invoice}"
BACKUP_DB_HOST="${BACKUP_DB_HOST:-localhost}"
BACKUP_DB_PORT="${BACKUP_DB_PORT:-5432}"
# Tier 357: container to `docker exec pg_dump` into. This used to be a
# hardcoded "de-invoice-postgres", which meant that when backend e2e ran
# against a throwaway database (PG_CONTAINER=...), the fire-drill spec's
# backup either fell through to a host pg_dump on :5432 (nothing there ->
# exit 1) or, if the developer's dev container happened to be running,
# silently dumped THAT database instead of the one under test. Read-only
# either way, but the wrong target. Dev default unchanged; production uses
# infra/prod/backup.sh and a container named de-invoice-postgres-prod, so it
# is not affected by this file.
PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"
BACKUP_DB_USER="${BACKUP_DB_USER:-de_invoice}"
BACKUP_DB_PASSWORD="${BACKUP_DB_PASSWORD:-de_invoice_pass}"
BACKUP_DB_NAME="${BACKUP_DB_NAME:-de_invoice}"
# Path of the attachments directory inside the
# StorageService's localPath. Default matches
# StorageService.getDefaultLocalPath().
ATTACHMENT_PATH="${ATTACHMENT_PATH:-$HOME/data/invoice-system}"
# Rotation: 7 daily + 4 weekly + monthly anchors.
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
# Optional S3 upload (skipped when BACKUP_S3_BUCKET
# is empty). Requires the AWS CLI.
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"

# ─── Helpers ───────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { log "ERROR: $*" >&2; }

# Stage dir: backup-YYYY-MM-DD-HHMMSS/  (one per
# run, contains db + attachments so the two are
# always restored together).
STAGE=$(date '+%Y-%m-%d-%H%M%S')
STAGE_DIR="$BACKUP_ROOT/backup-$STAGE"
mkdir -p "$STAGE_DIR"

EXIT_CODE=0

# ─── Stage 1: pg_dump ──────────────────────────────────────
# We prefer `docker exec` into the running postgres
# container because (a) it avoids installing
# postgresql-client on the host, and (b) it uses
# the same Postgres version as the live DB. If the
# container isn't running we fall back to a local
# pg_dump (system / brew install postgresql).
DB_FILE="$STAGE_DIR/db.sql.gz"
log "Dumping database to $DB_FILE"
dump_ok=0
if command -v docker >/dev/null 2>&1 && \
   docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PG_CONTAINER"; then
  # Container is up — dump from inside it.
  if docker exec "$PG_CONTAINER" pg_dump \
      -U "$BACKUP_DB_USER" \
      -d "$BACKUP_DB_NAME" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      > "$DB_FILE.tmp" 2>"$STAGE_DIR/db.dump.log"; then
    mv "$DB_FILE.tmp" "$DB_FILE"
    dump_ok=1
  fi
elif command -v pg_dump >/dev/null 2>&1; then
  # Fall back to local pg_dump.
  if PGPASSWORD="$BACKUP_DB_PASSWORD" pg_dump \
      --host="$BACKUP_DB_HOST" \
      --port="$BACKUP_DB_PORT" \
      --user="$BACKUP_DB_USER" \
      --dbname="$BACKUP_DB_NAME" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      --file="$DB_FILE.tmp" 2>"$STAGE_DIR/db.dump.log"; then
    mv "$DB_FILE.tmp" "$DB_FILE"
    dump_ok=1
  fi
else
  err "No docker / no local pg_dump — install postgresql-client"
  EXIT_CODE=1
fi
if [[ "$dump_ok" == "1" ]]; then
  DB_SIZE=$(du -h "$DB_FILE" | awk '{print $1}')
  log "DB dump OK ($DB_SIZE)"
else
  err "pg_dump failed — see $STAGE_DIR/db.dump.log"
  rm -f "$DB_FILE.tmp"
  EXIT_CODE=1
fi

# ─── Stage 2: attachments ─────────────────────────────────
if [[ -d "$ATTACHMENT_PATH" ]]; then
  ATT_FILE="$STAGE_DIR/attachments.tar.gz"
  log "Archiving $ATTACHMENT_PATH to $ATT_FILE"
  # tar with the basename at the archive root
  # (not the absolute path) so the restore is a
  # simple `tar -C / -xf` regardless of the
  # original location. We don't pass
  # --warning=no-file-changed because that's a
  # GNU-tar-only flag; on macOS / BSD tar we'd
  # fail. The race condition (a file gets added
  # mid-walk) is harmless — pg_dump has the
  # authoritative copy, and the attachments are
  # also recorded in the Attachment table.
  if tar -czf "$ATT_FILE" -C "$(dirname "$ATTACHMENT_PATH")" \
      "$(basename "$ATTACHMENT_PATH")" 2>"$STAGE_DIR/attachments.tar.log"; then
    ATT_SIZE=$(du -h "$ATT_FILE" | awk '{print $1}')
    log "Attachments archive OK ($ATT_SIZE)"
  else
    err "tar failed — see $STAGE_DIR/attachments.tar.log"
    EXIT_CODE=1
  fi
else
  log "No attachments dir at $ATTACHMENT_PATH (skipping)"
fi

# ─── Stage 3: optional S3 upload ───────────────────────────
if [[ -n "$BACKUP_S3_BUCKET" ]] && command -v aws >/dev/null 2>&1; then
  log "Uploading to s3://$BACKUP_S3_BUCKET/de-invoice/$STAGE/"
  if aws s3 cp "$STAGE_DIR/" "s3://$BACKUP_S3_BUCKET/de-invoice/$STAGE/" \
      --recursive --only-show-errors; then
    log "S3 upload OK"
  else
    err "S3 upload failed"
    EXIT_CODE=1
  fi
elif [[ -n "$BACKUP_S3_BUCKET" ]]; then
  err "BACKUP_S3_BUCKET set but aws CLI not installed"
fi

# ─── Stage 4: rotation ────────────────────────────────────
# Policy:
#   - Keep the last $KEEP_DAILY daily backups (one per
#     day, latest per day wins).
#   - Keep the last $KEEP_WEEKLY weekly backups
#     (Sundays only — the day changes the most, so
#     a Sunday-only weekly anchor captures the
#     month-end).
#   - Keep one per month for the current calendar
#     year (the "monthly anchor") — those are the
#     long-term retention copies.
#
# Implementation: list the dated dirs, group by
# (date, week, month) and pick the most recent of
# each. Anything not picked is deleted.
log "Rotating old backups (keep $KEEP_DAILY daily / $KEEP_WEEKLY weekly)"
ROTATE_KEEP=()
# Daily — one per day
DAILY_DATES=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}' \
  | awk -F- '{print $2"-"$3"-"$4}' \
  | sort -u | tail -n "$KEEP_DAILY")
for d in $DAILY_DATES; do
  # Keep the latest run of that day
  LATEST=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
    | grep -E "^backup-${d}-" | sort | tail -1)
  [[ -n "$LATEST" ]] && ROTATE_KEEP+=("$LATEST")
done
# Weekly — one per Sunday
WEEKLY_DATES=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}' \
  | awk -F- '{print $2"-"$3"-"$4}' \
  | while read d; do
      dow=$(date -j -f "%Y-%m-%d" "$d" "+%u" 2>/dev/null || date -d "$d" "+%u" 2>/dev/null)
      [[ "$dow" == "7" ]] && echo "$d"
    done | sort -u | tail -n "$KEEP_WEEKLY")
for d in $WEEKLY_DATES; do
  LATEST=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
    | grep -E "^backup-${d}-" | sort | tail -1)
  [[ -n "$LATEST" ]] && ROTATE_KEEP+=("$LATEST")
done
# Monthly — first-of-month runs only, this year
MONTHLY=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E "^backup-$(date +%Y)-" \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-01' | sort -u)
for m in $MONTHLY; do ROTATE_KEEP+=("$m"); done

# Delete anything not in KEEP
KEEPED=$(printf '%s\n' "${ROTATE_KEEP[@]}" | sort -u)
DELETED=0
for d in $(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E '^backup-[0-9]{4}'); do
  if ! echo "$KEEPED" | grep -qx "$d"; then
    rm -rf "$BACKUP_ROOT/$d"
    DELETED=$((DELETED + 1))
  fi
done
log "Kept $(echo "$KEEPED" | wc -l | tr -d ' ') backup(s), deleted $DELETED"

# ─── Final summary ────────────────────────────────────────
TOTAL_SIZE=$(du -sh "$STAGE_DIR" | awk '{print $1}')
log "Backup complete: $STAGE_DIR ($TOTAL_SIZE)"
exit $EXIT_CODE
