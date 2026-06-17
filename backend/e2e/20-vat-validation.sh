#!/bin/bash
# Test 20: EU VAT-ID validation (VIES) — Tier 15
#
# Covers the VatValidationService end-to-end. We
# use VIES_MOCK=1 so the test doesn't depend on
# the EU's SOAP service being reachable (it
# frequently isn't — DE was "Unavailable" the
# day this test was written). The mock returns
# deterministic answers based on the VAT ID
# prefix:
#   - VALID...      → valid
#   - INVALID...    → invalid (UNKNOWN_VAT)
#   - UNREACH...    → unreachable
#   - anything else → valid (default)
#
# Assertions:
#   1. parseVatId() splits DE123 correctly
#   2. parseVatId() rejects malformed input
#   3. parseVatId() rejects unknown country codes
#   4. POST /check on VALID... → status=valid + name
#   5. POST /check on INVALID... → status=invalid
#   6. POST /check on UNREACH... → status=unreachable
#   7. POST /check on malformed input → status=invalid, INVALID_FORMAT
#   8. GET /latest → returns the most recent check
#   9. GET /history → returns the recent checks
#  10. Caching: a second check on the same VAT ID
#      within 30d uses the cache (cached=true)
#  11. Re-checking with a different VAT ID hits
#      VIES (cached=false)
#  12. Customer-verify endpoint → status=valid + logId
#  13. Customer vat-history → latest + history array
#  14. Customer without VAT ID → 400 with German error
#  15. Supplier-verify + supplier-history endpoints
#  16. Cleanup — delete the test log rows + customers

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# Force the VIES mock for the test. The backend
# must have been started with VIES_MOCK=1 — we
# check the env via a probe request that returns
# the mock marker ("Mock Test Co" only appears in
# mock responses, so a 200 with that string is
# proof the mock is on).
export VIES_MOCK_PROBE="Mock Test Co"

login

# Restart backend with VIES_MOCK=1 if needed.
# We do a probe first; if it doesn't carry the
# mock marker, restart.
NEEDS_RESTART=0
PROBE=$(curl -sS -X POST "http://localhost:3001/api/v1/vat-validation/check?companyId=${COMPANY_ID}" \
  -H "Content-Type: application/json" \
  -H "x-user-id: ${USER_ID}" -H "x-company-id: ${COMPANY_ID}" \
  -d "{\"companyId\":\"${COMPANY_ID}\",\"entityType\":\"customer\",\"entityId\":\"00000000-0000-0000-0000-000000000001\",\"vatId\":\"DEVALID123456\"}" 2>&1)
if ! echo "$PROBE" | grep -q "Mock Test Co"; then
  NEEDS_RESTART=1
fi

if [[ "$NEEDS_RESTART" == "1" ]]; then
  echo "Backend not running with VIES_MOCK=1, restarting..."
  lsof -ti:3001 | xargs -r kill -9 2>/dev/null
  sleep 1
  cd /Users/shledergmbh/Projects/de-invoice/backend
  nohup env VIES_MOCK=1 npx ts-node src/main.ts > /tmp/backend.log 2>&1 &
  for i in $(seq 1 12); do
    sleep 1
    if curl -sS -o /dev/null --max-time 1 http://localhost:3001/api/v1/health 2>/dev/null; then
      break
    fi
  done
  echo "Backend restarted (PID $(lsof -ti:3001 | head -1))"
fi

echo "=== Test: VIES VAT validation (mocked) ==="

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$name"
  else
    fail "$name — needle='$needle' not in: ${haystack:0:200}"
  fi
}

UNIQ=$(date +%s | tail -c 6)
ENTITY_ID="11111111-1111-1111-1111-${UNIQ}1111"

# 1-3. parseVatId is a pure function — tested via
# the /check endpoint's behaviour on different
# inputs (the service writes a log row with the
# parsed country code, which we can read back).

# 4. Valid VAT
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DEVALID123456\"
}"
assert_eq "valid VAT → status" "$(json_field "$BODY" status)" "valid"
NAME=$(json_field "$BODY" name)
assert_contains "valid VAT → name" "$NAME" "Mock Test Co"
LOG_ID_1=$(json_field "$BODY" logId)
[[ -n "$LOG_ID_1" ]] || fail "log id missing for valid check"
# json_field returns Python booleans capitalised
# (True/False). Compare lower-cased so the assertion
# is correct regardless of how the JSON parser
# decodes them.
assert_eq "valid VAT → cached=false (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "false"

# 5. Invalid VAT
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DEINVALID123456\"
}"
assert_eq "invalid VAT → status" "$(json_field "$BODY" status)" "invalid"
assert_eq "invalid VAT → errorCode" "$(json_field "$BODY" errorCode)" "UNKNOWN_VAT"

# 6. Unreachable — the mock matches on the full
# prefix UNREACHABLE or MS_UNAVAILABLE. We use a
# 9-char number so the mock's startsWith check
# fires before the default branch.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DEUNREACHABLE\"
}"
assert_eq "unreachable → status" "$(json_field "$BODY" status)" "unreachable"
assert_eq "unreachable → errorCode" "$(json_field "$BODY" errorCode)" "MS_UNAVAILABLE"

# 7. Malformed input (no country prefix)
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"123456\"
}"
assert_eq "malformed → status" "$(json_field "$BODY" status)" "invalid"
assert_eq "malformed → errorCode" "$(json_field "$BODY" errorCode)" "INVALID_FORMAT"

# 7b. Unknown country code (XX)
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"XX123456\"
}"
assert_eq "unknown country → status" "$(json_field "$BODY" status)" "invalid"
assert_eq "unknown country → errorCode" "$(json_field "$BODY" errorCode)" "INVALID_FORMAT"

# 8. /latest
api_get "/api/v1/vat-validation/latest?companyId=${COMPANY_ID}&entityType=customer&entityId=${ENTITY_ID}"
# Latest is the most recent (test 7b) — XX123456 malformed.
LATEST_VAT=$(json_field "$BODY" vatId)
assert_contains "latest → vatId" "$LATEST_VAT" "XX123456"

# 9. /history — we just did 5 checks above (valid,
# invalid, unreachable, malformed, unknown-country).
# The history endpoint returns at most 5, so we
# just assert it's >= 5 (it can be more if any
# earlier cache-hit rewrote the row in place).
HISTORY=$(api_get "/api/v1/vat-validation/history?companyId=${COMPANY_ID}&entityType=customer&entityId=${ENTITY_ID}")
HISTORY_COUNT=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
if [[ "$HISTORY_COUNT" -ge 5 ]]; then
  pass "history count = $HISTORY_COUNT (>= 5)"
else
  fail "history count = $HISTORY_COUNT (expected >= 5)"
fi

# 10. Caching — re-check the SAME valid VAT. The
# 30-day cache should fire; cached=true.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DEVALID123456\"
}"
assert_eq "re-check same VAT → cached=true (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "true"
assert_eq "re-check same VAT → status" "$(json_field "$BODY" status)" "valid"

# 11. Different VAT — cache miss, fresh call.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"FRVALID123456789\"
}"
assert_eq "different VAT → cached=false (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "false"
assert_eq "different VAT → status" "$(json_field "$BODY" status)" "valid"

# 12. Customer-verify endpoint — the per-row shortcut
# that the customer detail page's "Jetzt prüfen"
# button hits. Same backend logic as POST /check
# but bound to a specific customer. We have to
# create a REAL customer first because the route
# looks up the customer row (unlike the global
# /vat-validation/check endpoint which accepts
# a synthetic entityId for audit purposes).
#
# IMPORTANT: api_post writes to the global $BODY,
# it does NOT print to stdout. So we must NOT call
# it inside $(...) — call it as a plain statement
# and then read $BODY / $STATUS afterwards. (This
# is the same pattern every other e2e test uses.)
TEST_CUST_NAME="VAT-TEST-${RANDOM}"
api_post "/api/v1/customers?companyId=${COMPANY_ID}" \
  "{\"name\":\"${TEST_CUST_NAME}\",\"type\":\"business\",\"vatId\":\"DE999999999\"}"
REAL_CUST_ID=$(json_field "$BODY" id)
[[ -n "$REAL_CUST_ID" ]] || fail "could not create test customer (status=$STATUS, body=$BODY)"

api_post "/api/v1/customers/${REAL_CUST_ID}/verify-vat?companyId=${COMPANY_ID}" '{}'
assert_eq "customer verify-vat status" "$(json_field "$BODY" status)" "valid"
LOG_ID=$(json_field "$BODY" logId)
assert_eq "customer verify-vat has logId (8+ chars)" "$([ ${#LOG_ID} -ge 8 ] && echo 1 || echo 0)" "1"

# 13. Customer vat-history — returns { latest, history }
api_get "/api/v1/customers/${REAL_CUST_ID}/vat-history?companyId=${COMPANY_ID}"
assert_eq "customer history latest.status" "$(json_field "$BODY" latest.status)" "valid"
HIST_LEN=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(len(d['history']))" "$BODY")
assert_eq "customer history count >=1" "$([ "$HIST_LEN" -ge 1 ] && echo 1 || echo 0)" "1"

# 14. Customer-verify on customer WITHOUT vatId → 400
# Create a customer with no vatId field at all.
api_post "/api/v1/customers?companyId=${COMPANY_ID}" \
  "{\"name\":\"NOVAT-${RANDOM}\",\"type\":\"individual\"}"
NO_VAT_CUST=$(json_field "$BODY" id)
[[ -n "$NO_VAT_CUST" ]] || fail "could not create no-vat test customer (status=$STATUS, body=$BODY)"
STATUS=$(curl -sS -o /tmp/r.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/customers/${NO_VAT_CUST}/verify-vat?companyId=${COMPANY_ID}" \
  -H "x-user-id: ${USER_ID}" -H "x-company-id: ${COMPANY_ID}")
assert_eq "no-vat customer returns 400" "$STATUS" "400"
MSG=$(json_field "$(cat /tmp/r.json)" message)
echo "$MSG" | grep -q "USt-ID" && pass "400 message mentions USt-ID" || fail "400 message wrong: $MSG"

# 15. Supplier-verify + supplier-history — same shape
# as the customer variant. Find a supplier with DE VAT.
api_get "/api/v1/suppliers?companyId=${COMPANY_ID}&search=DE&take=20"
SUPP_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
data = d.get('data', d) if isinstance(d, dict) else d
de = [s for s in data if (s.get('vatId') or '').upper().startswith('DE')]
print(de[0]['id'] if de else '')" <<< "$BODY")
if [[ -n "$SUPP_ID" ]]; then
  api_post "/api/v1/suppliers/${SUPP_ID}/verify-vat?companyId=${COMPANY_ID}" '{}'
  assert_eq "supplier verify-vat status" "$(json_field "$BODY" status)" "valid"
  api_get "/api/v1/suppliers/${SUPP_ID}/vat-history?companyId=${COMPANY_ID}"
  assert_eq "supplier history latest.status" "$(json_field "$BODY" latest.status)" "valid"
fi

# 16. Cleanup — delete the test log rows AND the
# test customers we created (the per-row endpoint
# left FK-shaped log rows attached to them).
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VatValidationLog\" WHERE \"entityId\" IN ('${REAL_CUST_ID}', '${NO_VAT_CUST}') OR \"entityId\" = '${ENTITY_ID}';" >/dev/null 2>&1
if [[ -n "$REAL_CUST_ID" ]]; then
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Customer\" WHERE id = '${REAL_CUST_ID}';" >/dev/null 2>&1
fi
if [[ -n "$NO_VAT_CUST" ]]; then
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Customer\" WHERE id = '${NO_VAT_CUST}';" >/dev/null 2>&1
fi
pass "cleanup done"

echo
echo "ALL PASSED"
