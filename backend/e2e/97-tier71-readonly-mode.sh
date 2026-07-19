#!/usr/bin/env bash
# e2e 97: Tier 71 — Steuerberater-Modus (Read-Only).
#
# Validates the new `x-readonly: 1` header
# that flags a request as read-only. The
# HeaderAuthGuard reads the flag and the
# RolesGuard checks it: any action NOT in
# the read-only allowlist (the *.read
# actions) is 403'd with a German error
# message.
#
# Scenarios:
#   1. GET endpoints work with x-readonly: 1
#      (all *.read actions are allowed).
#   2. POST endpoints are 403 with
#      x-readonly: 1.
#   3. PATCH endpoints are 403.
#   4. DELETE endpoints are 403.
#   5. Without x-readonly, POST works.
#   6. Without x-readonly, GET works.
#   7. The 403 message is in German.
#   8. x-readonly: 0 (or "false") is treated
#      as off — POST works.
#   9. Cross-tenant + x-readonly → 401
#      (unauthorized takes precedence over
#      forbidden).
#  10. Cleanup: no DB writes.
#
# Why a "berater" role isn't directly tested:
# The role distinction is purely labelling
# (berater = accountant permission rank).
# The x-readonly flag is the actual
# Steuerberater-Modus gate. Testing the
# role is covered by the existing tier 66
# mandant-switcher e2e.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# A real customer ID for the test. Pick the
# first one (any — we just need a valid
# UUID for the URL).
CUSTOMER_ID=$(curl -sS "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['id'])")
test -n "$CUSTOMER_ID" || fail "could not find a test customer"
pass "test customer=$CUSTOMER_ID"

# ───── 1. GET works with x-readonly: 1 ─────
echo
note "=== 1. GET with x-readonly: 1 → 200 ==="
RO_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1")
assert_eq "GET customers readonly=1" "$RO_STATUS" "200"

RO_STATUS2=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1")
assert_eq "GET invoices readonly=1" "$RO_STATUS2" "200"

RO_STATUS3=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/audit-logs?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1")
assert_eq "GET audit-logs readonly=1" "$RO_STATUS3" "200"

# ───── 2. POST is 403 with x-readonly: 1 ─────
echo
note "=== 2. POST with x-readonly: 1 → 403 ==="
RO_POST=$(curl -sS -w "\n%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tier71 RO Test", "type":"business"}')
RO_POST_STATUS=$(echo "$RO_POST" | tail -n1)
RO_POST_BODY=$(echo "$RO_POST" | sed '$d')
assert_eq "POST customer readonly=1" "$RO_POST_STATUS" "403"
# The error message is in German.
MSG_OK=$(echo "$RO_POST_BODY" | grep -c "Read-Only Modus aktiv" || true)
assert_eq "German error message" "$MSG_OK" "1"

# ───── 3. PATCH is 403 ─────
# Use the Mahnungspause PATCH endpoint (the
# only PATCH with a public route that's
# stable across runs). The customer PATCH
# route doesn't exist in this codebase.
echo
note "=== 3. PATCH with x-readonly: 1 → 403 ==="
# Create + immediately delete a test pause
# to get a valid id.
PAUSE_BODY=$(curl -sS -X POST \
  "$API/api/v1/mahnungspausen?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"'$CUSTOMER_ID'","reason":"tier71 setup","pausedUntil":null}')
PAUSE_ID=$(echo "$PAUSE_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [ -n "$PAUSE_ID" ] && [ "$PAUSE_ID" != "None" ]; then
  # Now PATCH it with readonly=1 → 403.
  RO_PATCH=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
    "$API/api/v1/mahnungspausen/$PAUSE_ID?companyId=$COMPANY_ID" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" \
    -H "x-readonly: 1" \
    -H "Content-Type: application/json" \
    -d '{"reason":"should fail"}')
  assert_eq "PATCH readonly=1" "$RO_PATCH" "403"
  # Cleanup
  curl -sS -o /dev/null -X DELETE \
    "$API/api/v1/mahnungspausen/$PAUSE_ID?companyId=$COMPANY_ID" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" || true
  pass "cleaned up test pause"
else
  fail "could not create setup pause"
fi

# ───── 4. DELETE is 403 ─────
echo
note "=== 4. DELETE with x-readonly: 1 → 403 ==="
RO_DEL=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
  "$API/api/v1/customers/$CUSTOMER_ID?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1")
assert_eq "DELETE customer readonly=1" "$RO_DEL" "403"

# ───── 5. POST works without x-readonly ─────
echo
note "=== 5. POST without x-readonly → 201 (normal flow) ==="
NORW_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tier71 Normal Test", "type":"business"}')
assert_eq "POST customer normal" "$NORW_STATUS" "201"

# Clean up the test customer immediately so
# we don't pollute the DB.
NORW_CUST_ID=$(curl -sS "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)['data']
for c in data:
  if c['name']=='Tier71 Normal Test':
    print(c['id'])
    break
")
if [ -n "$NORW_CUST_ID" ]; then
  curl -sS -o /dev/null -X DELETE \
    "$API/api/v1/customers/$NORW_CUST_ID?companyId=$COMPANY_ID" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" || true
  pass "cleaned up test customer"
fi

# ───── 6. GET works without x-readonly ─────
echo
note "=== 6. GET without x-readonly → 200 ==="
NORW_GET=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "GET customers normal" "$NORW_GET" "200"

# ───── 7. The 403 message is in German ─────
echo
note "=== 7. 403 message in German ==="
RO_BODY=$(curl -sS -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 1" \
  -H "Content-Type: application/json" \
  -d '{"name":"x", "type":"business"}')
GERMAN_OK=$(echo "$RO_BODY" | grep -c "Read-Only Modus aktiv — Schreibvorgang" || true)
assert_eq "German error format" "$GERMAN_OK" "1"

# ───── 8. x-readonly: 0 → treated as off ─────
echo
note "=== 8. x-readonly: 0 → POST works (treated as off) ==="
RO_ZERO=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -H "x-readonly: 0" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tier71 ReadOnlyZero Test", "type":"business"}')
assert_eq "POST customer readonly=0" "$RO_ZERO" "201"

# Cleanup
ZERO_ID=$(curl -sS "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)['data']
for c in data:
  if c['name']=='Tier71 ReadOnlyZero Test':
    print(c['id'])
    break
")
if [ -n "$ZERO_ID" ]; then
  curl -sS -o /dev/null -X DELETE \
    "$API/api/v1/customers/$ZERO_ID?companyId=$COMPANY_ID" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" || true
  pass "cleaned up zero-test customer"
fi

# ───── 9. Cross-tenant + x-readonly → 401 (precedence) ─────
echo
note "=== 9. cross-tenant + readonly → 401 (unauthorized over forbidden) ==="
CROSS_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-readonly: 1" \
  -H "Content-Type: application/json" \
  -d '{"name":"x", "type":"business"}')
assert_eq "cross-tenant precedence" "$CROSS_STATUS" "401"

# ───── 10. Cleanup summary ─────
echo
note "=== 10. cleanup complete ==="
pass "tier 71 cleanup done"

summary
exit $?
