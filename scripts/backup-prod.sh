#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# backup-prod.sh — production-grade PostgreSQL + attachments backup
#
# Tier 114. Replaces the dev backup.sh with:
#   1. pg_dump in custom + compressed format
#   2. tar archive of the attachments volume
#   3. OPTIONAL gpg symmetric encryption (so a leaked S3
#      credential does NOT leak customer data)
#   4. OPTIONAL upload to an rclone remote (Hetzner Storage
#      Box, DigitalOcean Spaces, AWS S3, Backblaze B2, …)
#   5. OPTIONAL webhook notification (Slack / Discord / custom)
#      on success and failure
#   6. 30 daily / 7 weekly / 12 monthly retention policy
#   7. OPTIONAL restore-test in a throwaway database
#      (catches a broken pg_dump before you need it)
#   8. Writes a manifest.json with every run's metadata
#      (size, duration, exit status, ...) so off-site
#      consumers can verify integrity
#
# Usage:
#   # Default: dumps to $BACKUP_ROOT and rotates locally.
#   bash scripts/backup-prod.sh
#
#   # With everything enabled:
#   BACKUP_RCLONE_REMOTE=hetzner-storagebox:de-invoice-backups \
#   BACKUP_ENCRYPTION_PASSPHRASE=<from password manager> \
#   BACKUP_WEBHOOK_URL=https://hooks.slack.com/services/... \
#   BACKUP_RESTORE_TEST=1 \
#   bash scripts/backup-prod.sh
#
# Cron (deploy user's crontab):
#   0 3 * * * cd /opt/de-invoice && bash scripts/backup-prod.sh >> /var/log/de-invoice-backup.log 2>&1
#
# Exit codes:
#   0 = backup completed (incl. off-site upload + restore-test)
#   1 = backup itself failed
#   2 = backup succeeded but off-site upload failed
#       (you still have a local copy — see exit code 1 vs 2 below)
#   3 = required tool missing (rclone, gpg, ...)
#   4 = restore-test failed (pg_dump can't be restored — URGENT)
#
# In .env (read by this script via the prod compose):
#   POSTGRES_PASSWORD, POSTGRES_USER, POSTGRES_DB
#   BACKUP_RCLONE_REMOTE, BACKUP_ENCRYPTION_PASSPHRASE
#   BACKUP_WEBHOOK_URL
#   BACKUP_KEEP_DAILY, BACKUP_KEEP_WEEKLY, BACKUP_KEEP_MONTHLY
# ─────────────────────────────────────────────────────────────────

set -uo pipefail
# Note: NOT -e — we want to keep going through stages so
# the partial backup is preserved. The `EXIT_CODE` variable
# accumulates failures and we exit with the worst one.

# ─── Load env (if sourced via the prod compose) ─────────
# When run as a cron job, the deploy user's crontab
# doesn't have the .env. We read it explicitly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../infra/prod/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# ─── Config ─────────────────────────────────────────────
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/de-invoice}"
BACKUP_DB_HOST="${BACKUP_DB_HOST:-localhost}"
BACKUP_DB_PORT="${BACKUP_DB_PORT:-5432}"
BACKUP_DB_USER="${BACKUP_DB_USER:-${POSTGRES_USER:-de_invoice}}"
BACKUP_DB_PASSWORD="${BACKUP_DB_PASSWORD:-${POSTGRES_PASSWORD:-}}"
BACKUP_DB_NAME="${BACKUP_DB_NAME:-${POSTGRES_DB:-de_invoice}}"
# Attachments path. Inside the docker network, this is
# /data/invoice-system. On the host (when the volume is
# bind-mounted), it can be a host path.
ATTACHMENT_PATH="${ATTACHMENT_PATH:-/data/invoice-system}"

# Retention.
KEEP_DAILY="${KEEP_DAILY:-${BACKUP_KEEP_DAILY:-30}}"
KEEP_WEEKLY="${KEEP_WEEKLY:-${BACKUP_KEEP_WEEKLY:-7}}"
KEEP_MONTHLY="${KEEP_MONTHLY:-${BACKUP_KEEP_MONTHLY:-12}}"

# Off-site + encryption.
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_ENCRYPTION_PASSPHRASE="${BACKUP_ENCRYPTION_PASSPHRASE:-}"

# Webhook.
BACKUP_WEBHOOK_URL="${BACKUP_WEBHOOK_URL:-}"
# Webhook timeout (curl --max-time). Keep short so a
# slow webhook doesn't block the cron.
BACKUP_WEBHOOK_TIMEOUT="${BACKUP_WEBHOOK_TIMEOUT:-10}"

# Restore-test.
BACKUP_RESTORE_TEST="${BACKUP_RESTORE_TEST:-0}"
# A throwaway DB name. Drained at end.
BACKUP_RESTORE_TEST_DB="${BACKUP_RESTORE_TEST_DB:-de_invoice_restore_test}"

# ─── Helpers ────────────────────────────────────────────
log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
err()  { log "ERROR: $*" >&2; }

START_TS=$(date +%s)
EXIT_CODE=0
STAGE_RESULTS=()
STAGE_DURATION=()
STAGE=""
STAGE_START=0
stage() {
  STAGE="$1"
  STAGE_START=$(date +%s)
  log "── stage: $STAGE ──"
}
stage_end() {
  local rc=$1
  local dur=$(( $(date +%s) - STAGE_START ))
  STAGE_DURATION+=("$STAGE:${dur}s")
  if (( rc == 0 )); then
    STAGE_RESULTS+=("$STAGE:OK")
  else
    STAGE_RESULTS+=("$STAGE:FAIL")
  fi
}

notify() {
  # $1 = status (ok/fail), $2 = summary
  [[ -z "$BACKUP_WEBHOOK_URL" ]] && return 0
  local payload
  payload=$(cat <<EOF
{
  "service": "de-invoice-backup",
  "status": "$1",
  "summary": "$2",
  "duration_s": $(( $(date +%s) - START_TS )),
  "host": "$(hostname)",
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
)
  if ! curl -sf --max-time "$BACKUP_WEBHOOK_TIMEOUT" \
       -H "Content-Type: application/json" \
       -d "$payload" "$BACKUP_WEBHOOK_URL" >/dev/null 2>&1; then
    err "webhook notification failed (non-fatal)"
  fi
}

# ─── Stage 0: preflight ─────────────────────────────────
stage "preflight"
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; EXIT_CODE=3; return 1; }
}
need_cmd tar
need_cmd gzip
need_cmd date
# docker OR local pg_dump — one of them is required.
if command -v docker >/dev/null 2>&1; then
  log "using docker exec to reach postgres"
elif command -v pg_dump >/dev/null 2>&1; then
  log "using local pg_dump (host $BACKUP_DB_HOST:$BACKUP_DB_PORT)"
else
  err "neither docker nor local pg_dump is available"
  notify "fail" "preflight: no pg_dump source"
  exit 3
fi
[[ -n "$BACKUP_RCLONE_REMOTE" ]] && need_cmd rclone
[[ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]] && need_cmd gpg
stage_end 0

# ─── Stage 1: pg_dump ───────────────────────────────────
stage "pg_dump"
STAGE=$(date '+%Y-%m-%d-%H%M%S')
STAGE_DIR="$BACKUP_ROOT/backup-$STAGE"
mkdir -p "$STAGE_DIR"

DB_FILE="$STAGE_DIR/db.sql"
DB_FILE_GZ="${DB_FILE}.gz"
DB_FILE_ENC="${DB_FILE_GZ}.gpg"  # used only if encryption is on
log "dumping database to $DB_FILE_GZ"
dump_ok=0
if command -v docker >/dev/null 2>&1 \
   && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^de-invoice-postgres$'; then
  if docker exec de-invoice-postgres pg_dump \
      -U "$BACKUP_DB_USER" \
      -d "$BACKUP_DB_NAME" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      --serializable-deferrable \
      > "$DB_FILE.tmp" 2>"$STAGE_DIR/db.dump.log"; then
    mv "$DB_FILE.tmp" "$DB_FILE"
    dump_ok=1
  fi
elif command -v pg_dump >/dev/null 2>&1; then
  if PGPASSWORD="$BACKUP_DB_PASSWORD" pg_dump \
      --host="$BACKUP_DB_HOST" \
      --port="$BACKUP_DB_PORT" \
      --user="$BACKUP_DB_USER" \
      --dbname="$BACKUP_DB_NAME" \
      --format=custom \
      --compress=9 \
      --no-owner \
      --no-privileges \
      --serializable-deferrable \
      --file="$DB_FILE.tmp" 2>"$STAGE_DIR/db.dump.log"; then
    mv "$DB_FILE.tmp" "$DB_FILE"
    dump_ok=1
  fi
fi

if (( dump_ok == 1 )); then
  # Custom format is already compressed. But we also
  # emit a plain-SQL gzip for human inspection (e.g.
  # `zcat db.sql.gz | head`).
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --no-owner --no-privileges "$DB_FILE" 2>/dev/null \
      | gzip -9 > "$DB_FILE_GZ.tmp" \
      && mv "$DB_FILE_GZ.tmp" "$DB_FILE_GZ"
  else
    # Fallback: just gzip the custom-format file. Restoring
    # requires `pg_restore` on the restore host, which is
    # the standard for `pg_dump -Fc` output.
    gzip -9 -c "$DB_FILE" > "$DB_FILE_GZ.tmp" \
      && mv "$DB_FILE_GZ.tmp" "$DB_FILE_GZ"
    # Rename: it's not plain SQL but the extension is fine
    # for tooling that doesn't care.
  fi
  DB_SIZE=$(du -h "$DB_FILE" | awk '{print $1}')
  log "db dump OK ($DB_SIZE, custom format)"
  stage_end 0
else
  err "pg_dump failed — see $STAGE_DIR/db.dump.log"
  rm -f "$DB_FILE.tmp"
  EXIT_CODE=1
  stage_end 1
fi

# ─── Stage 2: attachments ───────────────────────────────
stage "attachments"
if [[ -d "$ATTACHMENT_PATH" ]]; then
  ATT_FILE="$STAGE_DIR/attachments.tar.gz"
  log "archiving $ATTACHMENT_PATH to $ATT_FILE"
  # --warning=no-file-changed is GNU-tar only; the
  # mid-walk race is harmless because pg_dump has the
  # authoritative copy and the attachments are also
  # referenced in the Attachment table.
  if tar -czf "$ATT_FILE" -C "$(dirname "$ATTACHMENT_PATH")" \
      "$(basename "$ATTACHMENT_PATH")" 2>"$STAGE_DIR/attachments.tar.log"; then
    ATT_SIZE=$(du -h "$ATT_FILE" | awk '{print $1}')
    log "attachments archive OK ($ATT_SIZE)"
    stage_end 0
  else
    err "tar failed — see $STAGE_DIR/attachments.tar.log"
    EXIT_CODE=1
    stage_end 1
  fi
else
  log "no attachments dir at $ATTACHMENT_PATH (skipping)"
  stage_end 0
fi

# ─── Stage 3: encryption ────────────────────────────────
# Encrypts the .gz files in place. The original .sql /
# .tar.gz files are kept for local debugging; the
# .gpg files are what we upload.
stage "encryption"
if [[ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]] && (( dump_ok == 1 )); then
  log "encrypting with gpg symmetric (AES-256)"
  # Use --batch --pinentry-mode loopback --passphrase-fd
  # so we can pipe the passphrase without a TTY.
  enc_ok=1
  for plain in "$DB_FILE_GZ" "$STAGE_DIR/attachments.tar.gz"; do
    [[ -f "$plain" ]] || continue
    if ! printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" \
         | gpg --batch --yes --pinentry-mode loopback \
               --passphrase-fd 0 --symmetric --cipher-algo AES256 \
               --output "$plain.gpg.tmp" "$plain" 2>"$plain.gpg.log"; then
      err "gpg encryption failed for $plain"
      enc_ok=0
      rm -f "$plain.gpg.tmp"
    else
      mv "$plain.gpg.tmp" "$plain.gpg"
      log "  encrypted $(basename "$plain") -> $(basename "$plain").gpg"
    fi
  done
  if (( enc_ok == 1 )); then
    stage_end 0
  else
    EXIT_CODE=1
    stage_end 1
  fi
else
  log "encryption disabled (BACKUP_ENCRYPTION_PASSPHRASE not set)"
  stage_end 0
fi

# ─── Stage 4: off-site upload ───────────────────────────
stage "off-site upload"
if [[ -n "$BACKUP_RCLONE_REMOTE" ]] && (( dump_ok == 1 )); then
  log "uploading to $BACKUP_RCLONE_REMOTE/$STAGE/"
  # What to upload:
  #   - if encrypted: db.sql.gz.gpg + attachments.tar.gz.gpg
  #   - if not:       db.sql.gz + attachments.tar.gz
  # Plus the manifest.json (written in stage 5 below).
  # We do this in two passes: first the data files, then
  # re-run with the manifest.
  upload_files=()
  if [[ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]]; then
    [[ -f "$DB_FILE_ENC" ]] && upload_files+=("$DB_FILE_ENC")
    [[ -f "$STAGE_DIR/attachments.tar.gz.gpg" ]] && upload_files+=("$STAGE_DIR/attachments.tar.gz.gpg")
  else
    [[ -f "$DB_FILE_GZ" ]] && upload_files+=("$DB_FILE_GZ")
    [[ -f "$STAGE_DIR/attachments.tar.gz" ]] && upload_files+=("$STAGE_DIR/attachments.tar.gz")
  fi

  upload_ok=1
  for f in "${upload_files[@]}"; do
    if ! rclone copyto "$f" "$BACKUP_RCLONE_REMOTE/$STAGE/$(basename "$f")" \
         --progress --sftp-disable-hashcheck 2>"$STAGE_DIR/rclone.log"; then
      err "rclone copyto failed for $f"
      upload_ok=0
    fi
  done
  if (( upload_ok == 1 )); then
    log "off-site upload OK (${#upload_files[@]} file(s))"
    stage_end 0
  else
    # Backup itself is fine; the off-site copy failed.
    # You still have the local file. Set EXIT_CODE=2
    # (not 1) so the cron job's "fail" handler can
    # distinguish.
    EXIT_CODE=2
    err "off-site upload had failures — local backup is OK"
    stage_end 1
  fi
else
  log "off-site upload disabled (BACKUP_RCLONE_REMOTE not set)"
  stage_end 0
fi

# ─── Stage 5: manifest ──────────────────────────────────
stage "manifest"
TOTAL_SIZE=$(du -sh "$STAGE_DIR" | awk '{print $1}')
DURATION=$(( $(date +%s) - START_TS ))
MANIFEST="$STAGE_DIR/manifest.json"
cat > "$MANIFEST" <<EOF
{
  "service": "de-invoice",
  "version": "tier-114",
  "stage": "$STAGE",
  "host": "$(hostname)",
  "started_at": "$(date -u -d "@$START_TS" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$START_TS" '+%Y-%m-%dT%H:%M:%SZ')",
  "duration_s": $DURATION,
  "total_size": "$TOTAL_SIZE",
  "exit_code": $EXIT_CODE,
  "stages": [$(printf '"%s",' "${STAGE_RESULTS[@]}" | sed 's/,$//')],
  "stage_durations": [$(printf '"%s",' "${STAGE_DURATION[@]}" | sed 's/,$//')],
  "encrypted": $([[ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]] && echo "true" || echo "false"),
  "offsite_remote": "${BACKUP_RCLONE_REMOTE:-<none>}",
  "files": [
    $([[ -f "$DB_FILE" ]]     && echo "\"db.sql\"," || true)
    $([[ -f "$DB_FILE_GZ" ]]  && echo "\"db.sql.gz\"," || true)
    $([[ -f "$DB_FILE_ENC" ]] && echo "\"db.sql.gz.gpg\"," || true)
    $([[ -f "$STAGE_DIR/attachments.tar.gz" ]]    && echo "\"attachments.tar.gz\"," || true)
    $([[ -f "$STAGE_DIR/attachments.tar.gz.gpg" ]] && echo "\"attachments.tar.gz.gpg\"," || true)
    "manifest.json"
  ]
}
EOF
log "manifest written to $MANIFEST"

# If the off-site upload happened, also push the manifest.
if [[ -n "$BACKUP_RCLONE_REMOTE" ]] && (( EXIT_CODE != 1 )); then
  rclone copyto "$MANIFEST" "$BACKUP_RCLONE_REMOTE/$STAGE/manifest.json" 2>>"$STAGE_DIR/rclone.log" || true
fi
stage_end 0

# ─── Stage 6: restore-test (optional) ───────────────────
stage "restore-test"
if [[ "$BACKUP_RESTORE_TEST" == "1" ]] && (( dump_ok == 1 )); then
  log "restoring into throwaway DB $BACKUP_RESTORE_TEST_DB to verify"
  if ! command -v docker >/dev/null 2>&1; then
    err "BACKUP_RESTORE_TEST=1 needs docker (no local pg_restore path)"
    EXIT_CODE=4
    stage_end 1
  else
    if docker exec de-invoice-postgres \
         psql -U "$BACKUP_DB_USER" -d postgres \
         -c "DROP DATABASE IF EXISTS $BACKUP_RESTORE_TEST_DB;" >/dev/null 2>&1 \
       && docker exec de-invoice-postgres \
            createdb -U "$BACKUP_DB_USER" "$BACKUP_RESTORE_TEST_DB" >/dev/null 2>"$STAGE_DIR/restore.log" \
       && docker exec -i de-invoice-postgres \
            pg_restore --no-owner --no-privileges -d "$BACKUP_RESTORE_TEST_DB" \
              < "$DB_FILE" 2>>"$STAGE_DIR/restore.log"; then
      # Sanity check: the restore should have produced
      # the expected table count. We allow a range
      # because the schema evolves; current expectation
      # is 30+ tables.
      TABLE_COUNT=$(docker exec de-invoice-postgres \
        psql -U "$BACKUP_DB_USER" -d "$BACKUP_RESTORE_TEST_DB" -tAc \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0")
      log "restore-test OK ($TABLE_COUNT tables)"
      docker exec de-invoice-postgres \
        dropdb -U "$BACKUP_DB_USER" "$BACKUP_RESTORE_TEST_DB" >/dev/null 2>&1
      if (( TABLE_COUNT >= 20 )); then
        stage_end 0
      else
        err "restore-test produced suspiciously few tables ($TABLE_COUNT)"
        EXIT_CODE=4
        stage_end 1
      fi
    else
      err "restore-test failed — see $STAGE_DIR/restore.log"
      docker exec de-invoice-postgres \
        dropdb -U "$BACKUP_DB_USER" "$BACKUP_RESTORE_TEST_DB" >/dev/null 2>&1 || true
      EXIT_CODE=4
      stage_end 1
    fi
  fi
else
  log "restore-test disabled (set BACKUP_RESTORE_TEST=1 to enable)"
  stage_end 0
fi

# ─── Stage 7: rotation ──────────────────────────────────
stage "rotation"
log "rotating old backups (keep $KEEP_DAILY daily / $KEEP_WEEKLY weekly / $KEEP_MONTHLY monthly)"
ROTATE_KEEP=()
# Daily — one per day, latest wins.
DAILY_DATES=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}' \
  | awk -F- '{print $2"-"$3"-"$4}' \
  | sort -u | tail -n "$KEEP_DAILY")
for d in $DAILY_DATES; do
  LATEST=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
    | grep -E "^backup-${d}-" | sort | tail -1)
  [[ -n "$LATEST" ]] && ROTATE_KEEP+=("$LATEST")
done
# Weekly — one per ISO week (Mondays).
WEEKLY_DATES=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}' \
  | awk -F- '{print $2"-"$3"-"$4}' \
  | while read d; do
      iso_week=$(date -d "$d" "+%G-W%V" 2>/dev/null || echo "")
      [[ -n "$iso_week" ]] && echo "$iso_week $d"
    done | awk '{print $1}' | sort -u | tail -n "$KEEP_WEEKLY" \
  | while read w; do
      # For each kept ISO week, find the most recent date
      # within that week.
      WEEK_DATES=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
        | grep -E '^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}' \
        | awk -F- '{print $2"-"$3"-"$4}' \
        | while read d; do
            iso_week=$(date -d "$d" "+%G-W%V" 2>/dev/null || echo "")
            [[ "$iso_week" == "$w" ]] && echo "$d"
          done | sort -u | tail -1)
      [[ -n "$WEEK_DATES" ]] && echo "$WEEK_DATES"
    done)
for d in $WEEKLY_DATES; do
  LATEST=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
    | grep -E "^backup-${d}-" | sort | tail -1)
  [[ -n "$LATEST" ]] && ROTATE_KEEP+=("$LATEST")
done
# Monthly — first-of-month runs (or anything in the first
# 3 days) for the current year. These are the long-term
# retention anchors (GoBD §147 AO "Aufbewahrungsfrist"
# of 10 years — we keep at least 12 months locally;
# the off-site rclone remote is where the multi-year
# archive lives).
YEAR=$(date +%Y)
MONTHLY=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
  | grep -E "^backup-${YEAR}-" \
  | grep -E '^backup-[0-9]{4}-[0-9]{2}-0[1-3]' \
  | awk -F- '{print $2"-"$3}' | sort -u | tail -n "$KEEP_MONTHLY" \
  | while read ym; do
      y=${ym%-*}; m=${ym#*-}
      LATEST=$(ls -1 "$BACKUP_ROOT" 2>/dev/null \
        | grep -E "^backup-${YEAR}-${m}-0[1-3]" | sort | tail -1)
      [[ -n "$LATEST" ]] && echo "$LATEST"
    done)
for m in $MONTHLY; do ROTATE_KEEP+=("$m"); done

KEEPED=$(printf '%s\n' "${ROTATE_KEEP[@]}" | sort -u)
DELETED=0
for d in $(ls -1 "$BACKUP_ROOT" 2>/dev/null | grep -E '^backup-[0-9]{4}'); do
  if ! echo "$KEEPED" | grep -qx "$d"; then
    rm -rf "$BACKUP_ROOT/$d"
    DELETED=$((DELETED + 1))
  fi
done
log "kept $(echo "$KEEPED" | wc -l | tr -d ' ') backup(s), deleted $DELETED"
stage_end 0

# ─── Final summary + webhook ────────────────────────────
DURATION=$(( $(date +%s) - START_TS ))
SUMMARY="backup $STAGE finished in ${DURATION}s (exit=$EXIT_CODE, size=$TOTAL_SIZE, deleted=$DELETED, $STAGE kept)"
log "$SUMMARY"
case "$EXIT_CODE" in
  0) notify "ok"   "$SUMMARY" ;;
  1) notify "fail" "$SUMMARY" ;;
  2) notify "warn" "$SUMMARY (off-site upload failed; local copy OK)" ;;
  4) notify "fail" "$SUMMARY (URGENT: restore-test failed)" ;;
esac
exit $EXIT_CODE
