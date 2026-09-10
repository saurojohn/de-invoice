#!/bin/bash
# Tier 12: backup + restore fire-drill.
#
# The single most important operational
# guarantee is: a backup exists AND
# can be restored. An untested backup
# is the same as no backup — GoBD
# requires the originals to be
# retrievable for 10 years.
#
# This test runs the full round-trip:
#   1. Capture the current DB row
#      counts + a sentinel row
#   2. Insert a sentinel row
#   3. Run backup.sh
#   4. Verify the backup file exists
#      and is non-empty
#   5. Delete the sentinel row
#   6. Restore the backup to a
#      SCRATCH database
#   7. Verify the scratch DB has the
#      sentinel row (proof the backup
#      captured it)
#   8. Verify the live DB does NOT
#      have the sentinel row (we
#      deleted it; restore went to
#      scratch, not live)
#   9. Drop the scratch DB
#
# Why not restore to the live DB?
#   That's a destructive op. The
#   user has to type 'yes' to the
#   restore.sh prompt. A test that
#   bypasses that prompt is testing
#   the wrong thing. We restore to
#   a scratch DB to validate the
#   backup CONTENTS without
#   touching the running system.
#
# What this proves:
#   - backup.sh works
#   - The resulting dump is a valid
#     pg_dump custom format
#   - The data we cared about (the
#     sentinel row) is in the dump
#   - pg_restore can replay it
#   - The original DB is untouched
#
# What this DOESN'T prove:
#   - restore.sh's confirmation
#     prompt works (it does, by hand)
#   - The attachments archive round-trips
#     (we test only the DB part here;
#     the attachment round-trip is a
#     separate test that's blocked
#     on us having files in
#     ~/data/invoice-system/)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# The backup script lives at the repo
# root, not inside backend/. Resolve
# it relative to this file (4 levels
# up: e2e → backend → de-invoice).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_SCRIPT="$REPO_ROOT/scripts/backup.sh"
[[ -f "$BACKUP_SCRIPT" ]] || { echo "FATAL: backup script not found at $BACKUP_SCRIPT"; exit 1; }

echo "=== Test: Tier 12 backup + restore fire-drill ==="

# Use a temp BACKUP_ROOT so we don't
# pollute the user's existing backups.
export BACKUP_ROOT="/tmp/t12-backup-test"
export BACKUP_DB_HOST=localhost
export BACKUP_DB_PORT=5432
export BACKUP_DB_USER=de_invoice
export BACKUP_DB_PASSWORD=de_invoice_pass
export BACKUP_DB_NAME=de_invoice
rm -rf "$BACKUP_ROOT"
mkdir -p "$BACKUP_ROOT"

# ===== 1. Capture current row counts =====
USER_COUNT_BEFORE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"User\";" 2>/dev/null | tr -d ' ')
INVOICE_COUNT_BEFORE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Invoice\";" 2>/dev/null | tr -d ' ')
note "Before: $USER_COUNT_BEFORE users, $INVOICE_COUNT_BEFORE invoices"

# ===== 2. Insert a sentinel row =====
SENTINEL_COMPANY_ID="t12-fire-drill-$$"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Company\" (id, name, address, \"updatedAt\")
  VALUES ('$SENTINEL_COMPANY_ID', 'Fire Drill Sentinel', '{}'::jsonb, now());" >/dev/null 2>&1
SENTINEL_EXISTS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Company\" WHERE id = '$SENTINEL_COMPANY_ID';" 2>/dev/null | tr -d ' ')
[[ "$SENTINEL_EXISTS" -eq 1 ]] && pass "2. sentinel row inserted" || fail "2. sentinel insert FAILED"

# ===== 3. Run backup.sh =====
"$BACKUP_SCRIPT" > /tmp/t42_backup.log 2>&1
BACKUP_EXIT=$?
[[ $BACKUP_EXIT -eq 0 ]] && pass "3. backup.sh exit 0" || fail "3. backup.sh exit $BACKUP_EXIT: $(tail -5 /tmp/t42_backup.log)"

# ===== 4. Verify backup file exists =====
BACKUP_DIR=$(ls -1dt "$BACKUP_ROOT"/backup-* 2>/dev/null | head -1)
[[ -n "$BACKUP_DIR" ]] && pass "4a. backup dir created: $BACKUP_DIR" || fail "4a. no backup dir"
DB_FILE="$BACKUP_DIR/db.sql.gz"
[[ -f "$DB_FILE" ]] && pass "4b. db.sql.gz exists" || fail "4b. db.sql.gz MISSING"
DB_SIZE=$(du -h "$DB_FILE" 2>/dev/null | awk '{print $1}')
[[ -n "$DB_SIZE" && "$DB_SIZE" != "0" ]] && pass "4c. db dump is $DB_SIZE" || fail "4c. db dump empty"

# ===== 5. Delete the sentinel row =====
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"Company\" WHERE id = '$SENTINEL_COMPANY_ID';" >/dev/null 2>&1
SENTINEL_DELETED=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Company\" WHERE id = '$SENTINEL_COMPANY_ID';" 2>/dev/null | tr -d ' ')
[[ "$SENTINEL_DELETED" -eq 0 ]] && pass "5. sentinel row deleted from live DB" || fail "5. sentinel NOT deleted"

# ===== 6. Restore the backup to a scratch DB =====
SCRATCH_DB="t12_scratch_$$"
docker exec "$PG_CONTAINER" psql -U de_invoice -d postgres -c \
  "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d postgres -c \
  "CREATE DATABASE $SCRATCH_DB;" >/dev/null 2>&1
docker exec -i de-invoice-postgres pg_restore -U de_invoice -d $SCRATCH_DB \
  --no-owner --no-privileges < "$DB_FILE" 2>&1 | tail -3
RESTORE_OK=$?
[[ $RESTORE_OK -eq 0 ]] && pass "6. pg_restore to scratch DB: OK" \
  || fail "6. pg_restore FAILED with exit $RESTORE_OK"

# ===== 7. Verify scratch DB has the sentinel row =====
SENTINEL_IN_SCRATCH=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d $SCRATCH_DB -tA -c \
  "SELECT count(*) FROM \"Company\" WHERE id = '$SENTINEL_COMPANY_ID';" 2>/dev/null | tr -d ' ')
[[ "$SENTINEL_IN_SCRATCH" -eq 1 ]] && pass "7. sentinel row IS in restored scratch DB" \
  || fail "7. sentinel NOT in scratch — backup was incomplete"

# ===== 8. Verify the live DB does NOT have the sentinel =====
SENTINEL_IN_LIVE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Company\" WHERE id = '$SENTINEL_COMPANY_ID';" 2>/dev/null | tr -d ' ')
[[ "$SENTINEL_IN_LIVE" -eq 0 ]] && pass "8. live DB still has no sentinel (restore went to scratch, not live)" \
  || fail "8. sentinel still in live DB — restore may have touched the live DB!"

# ===== 9. Verify scratch DB has the same row counts as live (pre-delete) =====
SCRATCH_USERS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d $SCRATCH_DB -tA -c \
  "SELECT count(*) FROM \"User\";" 2>/dev/null | tr -d ' ')
SCRATCH_INVOICES=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d $SCRATCH_DB -tA -c \
  "SELECT count(*) FROM \"Invoice\";" 2>/dev/null | tr -d ' ')
[[ "$SCRATCH_USERS" -eq "$USER_COUNT_BEFORE" && "$SCRATCH_INVOICES" -eq "$INVOICE_COUNT_BEFORE" ]] \
  && pass "9. scratch DB row counts match live: $SCRATCH_USERS users, $SCRATCH_INVOICES invoices" \
  || fail "9. row counts differ: live=$USER_COUNT_BEFORE/$INVOICE_COUNT_BEFORE scratch=$SCRATCH_USERS/$SCRATCH_INVOICES"

# ===== 10. Drop the scratch DB =====
docker exec "$PG_CONTAINER" psql -U de_invoice -d postgres -c \
  "DROP DATABASE IF EXISTS $SCRATCH_DB;" >/dev/null 2>&1
note "Scratch DB dropped"

# ----- Cleanup -----
# Remove the test backup so we don't
# leave files in /tmp.
/Users/shledergmbh/.mavis/bin/mavis-trash -- /tmp/t42_backup.log /tmp/t12-backup-test
note "Cleanup done"

summary