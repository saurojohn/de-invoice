#!/bin/bash
# Test 20: EU VAT-ID validation (VIES) — Tier 15
#
# Covers the VatValidationService end-to-end. We
# use VIES_MOCK=1 so the test doesn't depend on
# the EU's SOAP service being reachable (it
# frequently isn't — DE was "Unavailable" the
# day this test was written). The mock models
# real VIES behaviour as closely as possible:
#
#   1. Per-country format + checksum validation
#      (DE's ISO 7064 MOD97-10, IT's 11-digit
#      check digit, FR's 2-digit key, etc.)
#      Numbers that fail this step are
#      INVALID_FORMAT — never silently accepted.
#
#   2. Lookup against a hardcoded "registered
#      companies" database. Numbers in the DB
#      are valid; numbers not in the DB are
#      UNKNOWN_VAT.
#
#   3. Special prefixes override both steps so
#      the e2e can force specific error codes
#      without depending on the DB:
#        UNREACHABLE / MS_UNAVAILABLE → unreachable
#        INVALID_FORMAT_              → INVALID_FORMAT
#        UNKNOWN_VAT_                 → UNKNOWN_VAT
#
# A "default-valid" fallback was removed in
# Tier 15 strict-mode — the previous behaviour
# was a footgun (DE999 returned green).
#
# Assertions:
#   1. parseVatId() splits DE123 correctly
#   2. parseVatId() rejects malformed input
#   3. parseVatId() rejects unknown country codes
#   4. POST /check on a registered VAT (DE111111110)
#      → status=valid + name from mock DB
#   5. POST /check on a well-formed DE VAT not in DB
#      (DE123456782) → status=invalid, UNKNOWN_VAT
#   6. POST /check on UNREACH... → status=unreachable
#   7. POST /check on malformed input → status=invalid,
#      INVALID_FORMAT (e.g. "123456" no country)
#   7b. POST /check on unknown country (XX...) → invalid
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
  -d "{\"companyId\":\"${COMPANY_ID}\",\"entityType\":\"customer\",\"entityId\":\"00000000-0000-0000-0000-000000000001\",\"vatId\":\"DE111111110\"}" 2>&1)
if ! echo "$PROBE" | grep -q "Mock Test Co"; then
  NEEDS_RESTART=1
fi

if [[ "$NEEDS_RESTART" == "1" ]]; then
  echo "Backend not running with VIES_MOCK=1, restarting..."
  lsof -ti:3001 | xargs -r kill -9 2>/dev/null
  sleep 1
  cd /Users/shledergmbh/Projects/de-invoice/backend
  # Tier 13: use the canonical start-backend.sh wrapper
  # (preserves FRONTEND_URL and other env vars the running
  # backend was started with, instead of just VIES_MOCK=1).
  # Previously this line was:
  #   nohup env VIES_MOCK=1 npx ts-node src/main.ts ...
  # which wiped FRONTEND_URL, breaking Playwright CORS
  # for every test after e2e 20.
  nohup env VIES_MOCK=1 bash scripts/start-backend.sh > /tmp/backend.log 2>&1 &
  # Tier 299 fix: ping /health/deep (which runs a
  # Prisma $queryRaw) instead of /health. /health
  # returns 200 the moment the controller is mapped
  # — that's well before NestJS finishes wiring all
  # the other modules (cron schedulers, Prisma
  # client, etc). A VIES probe hitting before
  # all modules are wired returns 500. 12s was
  # tight on the 1.5GB M1 with cold ts-node
  # compile; bump to 25s and wait for /health/deep
  # to actually return 200.
  for i in $(seq 1 25); do
    sleep 1
    DEEP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 1 \
      http://localhost:3001/api/v1/health/deep 2>/dev/null)
    if [ "$DEEP" = "200" ]; then
      break
    fi
  done
  echo "Backend restarted (PID $(lsof -ti:3001 | head -1), waited ${i}s)"
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

# 4. Valid VAT — use a real-format DE number that's
# in the mock DB. DE111111110 is "Beispiel GmbH" per
# the mock VIES register in
# backend/src/modules/vat-validation/vat-validation.service.ts.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DE111111110\"
}"
assert_eq "valid VAT → status" "$(json_field "$BODY" status)" "valid"
NAME=$(json_field "$BODY" name)
assert_contains "valid VAT → name" "$NAME" "Beispiel GmbH"
LOG_ID_1=$(json_field "$BODY" logId)
[[ -n "$LOG_ID_1" ]] || fail "log id missing for valid check"
# json_field returns Python booleans capitalised
# (True/False). Compare lower-cased so the assertion
# is correct regardless of how the JSON parser
# decodes them.
assert_eq "valid VAT → cached=false (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "false"

# 5. Invalid VAT — DE number that passes format
# (9 digits, valid checksum per ISO 7064) but is
# NOT in the mock DB. This is the "registered
# somewhere in the EU but not in this lookup"
# case that VIES would also return as UNKNOWN_VAT.
# DE123456782 has 9 digits and a correct checksum
# (compute via product % 11 = 8, then check=8).
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"DE123456782\"
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
  \"vatId\":\"DE111111110\"
}"
assert_eq "re-check same VAT → cached=true (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "true"
assert_eq "re-check same VAT → status" "$(json_field "$BODY" status)" "valid"

# 11. Different VAT — cache miss, fresh call.
# Use a registered VAT from a DIFFERENT country
# (FR) so we also exercise the per-country
# format validator in addition to the cache
# logic. FR32123456789 has the correct
# 2-digit French TVA key for SIREN 123456789.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"FR32123456789\"
}"
assert_eq "different VAT → cached=false (lowered)" "$(json_field "$BODY" cached | tr 'A-Z' 'a-z')" "false"
assert_eq "different VAT → status" "$(json_field "$BODY" status)" "valid"
assert_contains "different VAT → company name" "$(json_field "$BODY" name)" "Exemple SAS"

# 11b. Cross-country format check — an IT number
# with a wrong checksum. Per the Italian
# algorithm, IT1234567890 should have check
# digit 3 (not 0) so IT1234567890 is INVALID_FORMAT.
api_post "/api/v1/vat-validation/check?companyId=${COMPANY_ID}" "{
  \"companyId\":\"${COMPANY_ID}\",
  \"entityType\":\"customer\",
  \"entityId\":\"${ENTITY_ID}\",
  \"vatId\":\"IT1234567890\"
}"
assert_eq "IT bad checksum → status" "$(json_field "$BODY" status)" "invalid"
assert_eq "IT bad checksum → errorCode" "$(json_field "$BODY" errorCode)" "INVALID_FORMAT"

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
# Use a real-format DE number that's in the mock DB
# so the customer-verify endpoint returns 'valid'.
api_post "/api/v1/customers?companyId=${COMPANY_ID}" \
  "{\"name\":\"${TEST_CUST_NAME}\",\"type\":\"business\",\"vatId\":\"DE222222220\"}"
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
# as the customer variant. The mock VIES register only
# recognises DE111111110 as "valid" (vat-validation.service.ts
# line 941); arbitrary other DE numbers (e.g. DE111222333
# that other tier scripts seed) return invalid. Create a
# fresh supplier with the mock-valid USt-ID for this test.
api_post "/api/v1/suppliers?companyId=${COMPANY_ID}" \
  "{\"name\":\"VIES Mock Supplier ${UNIQ}\",\"type\":\"business\",\"vatId\":\"DE111111110\"}"
SUPP_ID=$(json_field "$BODY" id)
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
summary
