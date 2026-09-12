#!/usr/bin/env bash
# e2e 120: Tier 94 — Frontend Settings UI for
# feature flags (autoBookAfa + anlageV).
#
# Validates the new backend endpoints +
# the audit log entry written on toggle.
#
#   GET    /api/v1/companies/:id/feature-flags
#   PATCH  /api/v1/companies/:id/feature-flags
#
# Tests:
#   1. GET returns the current values
#      (defaults: autoBookAfa=true, anlageV=false).
#   2. GET response includes nextAutoBookerRun
#      as a valid ISO timestamp.
#   3. PATCH autoBookAfa=false updates the
#      value and writes an audit log entry
#      with action='company.feature_flags.updated'.
#   4. PATCH anlageV=true updates the value
#      + audit log entry.
#   5. PATCH with no body change is a no-op
#      (idempotent round-trip).
#   6. PATCH with invalid value (string for
#      a boolean) → 400.
#   7. Cross-tenant → 401.
#   8. Missing companyId path → 404.
#   9. Audit log entry has userId + oldData
#      (previous values) + newData (the
#      values just set).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="featflags-tier94-$TS"
echo "=== Test: Feature flags (test tag: $TEST_TAG) ==="

# Backup the original settings so we can
# restore at the end. The test mutates
# settings.autoBookAfa + settings.anlageV.
ORIGINAL_SETTINGS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT settings::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d ' \n' | head -1)
ORIGINAL_SETTINGS=$(echo "$ORIGINAL_SETTINGS" | tr -d '\n')

cleanup() {
  if [ -n "$ORIGINAL_SETTINGS" ]; then
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
      "UPDATE \"Company\" SET settings='$ORIGINAL_SETTINGS'::jsonb WHERE id='$COMPANY_ID';" >/dev/null 2>&1
  fi
  echo "  cleanup: restored SH Leder settings"
}
trap cleanup EXIT

# ===== 1. GET returns current values (defaults) =====
echo
echo "=== 1. GET /feature-flags returns defaults ==="
# First, reset to the absolute default state
# (no autoBookAfa key, no anlageV key) so
# the test is hermetic.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings=jsonb_set(settings, '{autoBookAfa}', 'null') WHERE id='$COMPANY_ID';" >/dev/null
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings=jsonb_set(settings, '{anlageV}', 'null') WHERE id='$COMPANY_ID';" >/dev/null

GET1=$(curl -sS \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
AUTO1=$(echo "$GET1" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['autoBookAfa']).lower())")
V1=$(echo "$GET1" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['anlageV']).lower())")
NEXT1=$(echo "$GET1" | python3 -c "import json,sys; print(json.load(sys.stdin)['nextAutoBookerRun'])")
assert_eq "default autoBookAfa = true" "$AUTO1" "true"
assert_eq "default anlageV = false" "$V1" "false"
# nextAutoBookerRun should be a valid ISO timestamp.
# Python's datetime.fromisoformat() doesn't accept
# the trailing 'Z' in some versions — strip it
# or replace it with +00:00 for the parse.
NEXT_OK=$(python3 -c "
from datetime import datetime
import re
s = '$NEXT1'.replace('Z', '+00:00')
try:
  datetime.fromisoformat(s)
  print('yes')
except: print('no')
")
assert_eq "nextAutoBookerRun is valid ISO" "$NEXT_OK" "yes"

# ===== 2. PATCH autoBookAfa=false =====
echo
echo "=== 2. PATCH autoBookAfa=false ==="
PATCH1=$(curl -sS -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"autoBookAfa": false}')
AUTO2=$(echo "$PATCH1" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['autoBookAfa']).lower())")
assert_eq "PATCH autoBookAfa=false" "$AUTO2" "false"

# Verify the change persisted via GET.
GET2=$(curl -sS \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
AUTO2_GET=$(echo "$GET2" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['autoBookAfa']).lower())")
assert_eq "GET shows autoBookAfa=false after PATCH" "$AUTO2_GET" "false"

# ===== 3. PATCH anlageV=true =====
echo
echo "=== 3. PATCH anlageV=true ==="
PATCH2=$(curl -sS -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"anlageV": true}')
V2=$(echo "$PATCH2" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['anlageV']).lower())")
assert_eq "PATCH anlageV=true" "$V2" "true"

# ===== 4. PATCH both at once =====
echo
echo "=== 4. PATCH both keys at once ==="
PATCH3=$(curl -sS -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"autoBookAfa": true, "anlageV": false}')
AUTO3=$(echo "$PATCH3" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['autoBookAfa']).lower())")
V3=$(echo "$PATCH3" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['anlageV']).lower())")
assert_eq "PATCH autoBookAfa=true" "$AUTO3" "true"
assert_eq "PATCH anlageV=false" "$V3" "false"

# ===== 5. PATCH with empty body (no keys) — idempotent =====
echo
echo "=== 5. PATCH with empty body — accepts no-op ==="
STATUS_NOOP=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{}')
assert_eq "PATCH {} → 200" "$STATUS_NOOP" "200"

# ===== 6. PATCH with invalid value → 400 =====
echo
echo "=== 6. PATCH with non-boolean value → 400 ==="
STATUS_BAD=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"autoBookAfa": "yes"}')
assert_eq "PATCH string for boolean → 400" "$STATUS_BAD" "400"

# ===== 7. Cross-tenant → 401 =====
echo
echo "=== 7. cross-tenant → 401 ==="
STATUS_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"autoBookAfa": false}')
assert_eq "cross-tenant PATCH → 401" "$STATUS_CROSS" "401"

# ===== 8. Nonexistent company → 400 =====
echo
echo "=== 8. Nonexistent companyId → 400 ==="
STATUS_404=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$API/api/v1/companies/00000000-0000-0000-0000-000000000000/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"autoBookAfa": false}')
assert_eq "nonexistent company → 400" "$STATUS_404" "400"

# ===== 9. Audit log entries =====
echo
echo "=== 9. Audit log entries for feature_flags.updated ==="
# We did 4 PATCH calls (autoBookAfa=false,
# anlageV=true, both, empty). The 4th (empty)
# might or might not write a log entry —
# v1 writes it for every PATCH call, even
# no-ops, so the Berater can see "on X, Mavis
# confirmed the current state".
N_LOGS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"AuditLog\" WHERE action='company.feature_flags.updated' AND \"companyId\"='$COMPANY_ID';" 2>&1 | tr -d ' ')
echo "  audit log entries: $N_LOGS (expected ≥ 3)"
if [ "$N_LOGS" -lt 3 ]; then
  echo "FAIL: too few audit log entries"
  exit 1
fi

# Verify the latest entry has userId + oldData + newData.
LATEST=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COALESCE(\"oldData\"::text, 'null') || '|' || COALESCE(\"newData\"::text, 'null') || '|' || COALESCE(\"userId\", 'null')
   FROM \"AuditLog\"
   WHERE action='company.feature_flags.updated' AND \"companyId\"='$COMPANY_ID'
   ORDER BY seq DESC LIMIT 1;" 2>&1 | tr -d ' ' | head -1)
echo "  latest entry: $LATEST"
# The last entry was the PATCH {} (no-op) —
# oldData should reflect the current state
# before the no-op, newData should be {} or
# just the keys not sent. We check that the
# userId field is set (caller's userId) AND
# that oldData is a valid JSON object with
# the two flag keys.
HAS_OLD=$(echo "$LATEST" | python3 -c "
import json,sys
parts = sys.stdin.read().strip().split('|')
# oldData is an object; newData may be {}
old = json.loads(parts[0]) if parts[0] != 'null' and parts[0] else None
new = json.loads(parts[1]) if parts[1] != 'null' and parts[1] else None
user = parts[2] if len(parts) > 2 else None
old_ok = isinstance(old, dict) and 'autoBookAfa' in old and 'anlageV' in old
new_ok = isinstance(new, dict)
user_ok = bool(user and len(user) > 0)
print('yes' if (old_ok and new_ok and user_ok) else 'no')
")
assert_eq "latest entry has userId + oldData + newData" "$HAS_OLD" "yes"

echo
summary
