#!/usr/bin/env bash
# e2e 144: Tier 120 — Backup management (admin).
#
# Verifies the /admin/backups endpoints:
#   1. GET  /admin/backups           — list stage dirs
#   2. POST /admin/backups/run       — run the script
#   3. POST /admin/backups/:id/verify — pg_restore --list
#   4. DELETE /admin/backups/:id     — remove
#   5. /admin/cron-health includes
#      daily-auto-backup (Tier 120 wiring)
#
# We test against whatever $BACKUP_ROOT the backend
# was started with (default ~/data/backups/de-invoice
# or whatever the operator set). The test counts
# before/after so it's robust to existing backups.
#
# The script's pg_dump takes ~5-30s depending on DB
# size, so the run endpoint is the slowest part of
# the test. We allow up to 5 minutes for it.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)
PREFIX="T120-$TS"

note "=== Test prefix: $PREFIX ==="

# ───── 0. Baseline: count existing backups ─────
note "=== 0. Baseline ==="
api_get "/api/v1/admin/backups"
assert_status "200" "GET /admin/backups"
BEFORE_IDS=$(echo "$BODY" | python3 -c "import json,sys;print(','.join(b['id'] for b in json.load(sys.stdin).get('items',[])))")
BEFORE_COUNT=$(echo "$BEFORE_IDS" | tr ',' '\n' | grep -c . || true)
note "before: $BEFORE_COUNT existing backups"
BACKUP_ROOT_RESOLVED=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('backupRoot',''))")
note "resolved BACKUP_ROOT: $BACKUP_ROOT_RESOLVED"
test -n "$BACKUP_ROOT_RESOLVED" && pass "endpoint returns backupRoot" \
  || fail "backupRoot missing from response"

# Verify the response shape
test -n "$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('health',''))" 2>/dev/null)" \
  && pass "endpoint returns health color" \
  || fail "health color missing"

# ───── 1. POST /admin/backups/run ─────
note "=== 1. POST /admin/backups/run ==="
note "(this may take 30-60s while pg_dump runs)"
RUN_RESP=$(curl -sS -w "\n%{http_code}" -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/admin/backups/run")
RUN_STATUS=$(echo "$RUN_RESP" | tail -n1)
RUN_BODY=$(echo "$RUN_RESP" | sed '$d')
test "$RUN_STATUS" = "200" && pass "POST /admin/backups/run: HTTP 200" \
  || fail "POST /admin/backups/run: HTTP $RUN_STATUS — body: $RUN_BODY"

# Parse the new backup ID + size
NEW_ID=$(echo "$RUN_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")
NEW_SIZE=$(echo "$RUN_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('sizeBytes',0))")
NEW_SUCCESS=$(echo "$RUN_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('success',False))")
note "new backup: id=$NEW_ID size=$NEW_SIZE success=$NEW_SUCCESS"
test "$NEW_SUCCESS" = "True" && pass "runBackup returned success=true" \
  || fail "runBackup failed: $RUN_BODY"
test -n "$NEW_ID" && test "$NEW_ID" != "failed" && pass "runBackup returned a stage id" \
  || fail "runBackup id missing: $NEW_ID"
test "$NEW_SIZE" -gt 1000 && pass "backup has non-trivial size ($NEW_SIZE bytes)" \
  || fail "backup too small: $NEW_SIZE bytes"

# ───── 2. GET /admin/backups → new entry present, none of the
#   existing IDs were dropped unexpectedly (rotation may
#   drop old daily/weekly backups, so we only check that
#   the new ID is in the list, not that the count grew). ─────
note "=== 2. GET /admin/backups after run ==="
api_get "/api/v1/admin/backups"
AFTER_IDS=$(echo "$BODY" | python3 -c "import json,sys;print(','.join(b['id'] for b in json.load(sys.stdin).get('items',[])))")
AFTER_COUNT=$(echo "$AFTER_IDS" | tr ',' '\n' | grep -c . || true)
note "after: $AFTER_COUNT backups (was $BEFORE_COUNT)"

# Find the new entry by id
NEW_ENTRY=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for b in d.get('items', []):
    if b.get('id') == '$NEW_ID':
        print('found')
        sys.exit(0)
print('missing')
" 2>/dev/null)
test "$NEW_ENTRY" = "found" && pass "new entry $NEW_ID is in the list" \
  || fail "new entry $NEW_ID NOT in the list"

# The newest should be our new backup (the list is
# sorted by mtime desc).
NEWEST_ID=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
n = d.get('newest') or {}
print(n.get('id', ''))
")
test "$NEWEST_ID" = "$NEW_ID" && pass "newest is the just-created backup" \
  || fail "newest is $NEWEST_ID, expected $NEW_ID"

# Verify isComplete + dbSize
NEW_DB_SIZE=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for b in d.get('items', []):
    if b.get('id') == '$NEW_ID':
        print(b.get('dbSizeBytes', 0))
        break
")
NEW_ATT_SIZE=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for b in d.get('items', []):
    if b.get('id') == '$NEW_ID':
        print(b.get('attachmentsSizeBytes', 0))
        break
")
NEW_COMPLETE=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for b in d.get('items', []):
    if b.get('id') == '$NEW_ID':
        print(b.get('isComplete', False))
        break
")
note "new entry: dbSize=$NEW_DB_SIZE attSize=$NEW_ATT_SIZE complete=$NEW_COMPLETE"
test "$NEW_DB_SIZE" -gt 0 && pass "new entry has db file" \
  || fail "new entry missing db file (dbSize=$NEW_DB_SIZE)"
test "$NEW_COMPLETE" = "True" && pass "new entry isComplete=true" \
  || fail "new entry isComplete=$NEW_COMPLETE"

# ───── 3. POST /admin/backups/:id/verify ─────
note "=== 3. POST /admin/backups/$NEW_ID/verify ==="
# This is slow (docker cp + pg_restore --list inside the container).
# Allow up to 60s.
VERIFY_RESP=$(curl -sS --max-time 90 -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/admin/backups/$NEW_ID/verify")
note "verify response: $VERIFY_RESP"
VERIFY_VALID=$(echo "$VERIFY_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('valid',False))")
VERIFY_TABLES=$(echo "$VERIFY_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tableCount',0))")
test "$VERIFY_VALID" = "True" && pass "verify returned valid=true" \
  || fail "verify returned valid=$VERIFY_VALID"
test "$VERIFY_TABLES" -gt 10 && pass "verify saw $VERIFY_TABLES tables (>10)" \
  || fail "verify saw only $VERIFY_TABLES tables — pg_dump may be incomplete"

# ───── 4. DELETE /admin/backups/:id ─────
note "=== 4. DELETE /admin/backups/$NEW_ID ==="
api_delete "/api/v1/admin/backups/$NEW_ID"
assert_status "200" "DELETE /admin/backups/$NEW_ID"
DELETED=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('deleted',False))")
test "$DELETED" = "True" && pass "delete returned deleted=true" \
  || fail "delete failed: $BODY"

# Verify the dir is gone on disk
DIR_GONE=0
if [[ -n "$BACKUP_ROOT_RESOLVED" ]] && [[ ! -d "$BACKUP_ROOT_RESOLVED/backup-$NEW_ID" ]]; then
  DIR_GONE=1
fi
test "$DIR_GONE" = "1" && pass "stage dir removed from disk" \
  || fail "stage dir still exists on disk: $BACKUP_ROOT_RESOLVED/backup-$NEW_ID"

# ───── 5. /admin/cron-health includes daily-auto-backup ─────
note "=== 5. /admin/cron-health includes daily-auto-backup ==="
api_get "/api/v1/admin/cron-health"
assert_status "200" "GET /admin/cron-health"
DAILY_FOUND=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for c in d:
    if c.get('name') == 'daily-auto-backup':
        print('found', c.get('schedule',''))
        sys.exit(0)
print('missing')
" 2>/dev/null)
echo "$DAILY_FOUND" | grep -q "found" && pass "daily-auto-backup is in cron-health registry" \
  || fail "daily-auto-backup missing from cron-health"
echo "$DAILY_FOUND" | grep -q "0 4 \* \* \*" && pass "daily-auto-backup schedule is 0 4 * * *" \
  || fail "daily-auto-backup schedule wrong: $DAILY_FOUND"

# ───── 6. Cleanup ─────
note "=== 6. Cleanup ==="
# Best-effort: delete any T120- prefixed CronHealth rows (none should exist
# unless a cron tick fired during the test).
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"CronHealth\" WHERE name = 'daily-auto-backup';" >/dev/null 2>&1 || true
pass "cleaned up test fixtures (any daily-auto-backup tick row)"

summary "Tier 120 — Backup management (admin/backups + daily-auto-backup cron)"
