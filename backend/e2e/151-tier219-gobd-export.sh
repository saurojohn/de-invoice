#!/bin/bash
# Tier 219 — GET /gobd-export (GoBD ZIP archive)
# Backend e2e coverage for the /gobd-export endpoint
# that streams a § 147 AO GoBD-compliant ZIP archive
# (invoices + creditNotes + mahnungen + recurrings +
# emails + audit log + signed/unsigned PDFs).
#
# 103-tier77-gobd-archive.sh covers the /accounting/
# gobd-archive + /gobd-archive/summary endpoints. This
# script covers the parallel /gobd-export endpoint
# which has different stats (includes recurrings +
# emails + signed/unsigned pdf split).
#
# Tests:
#   1. Year validation: 1999, 2101 → 400
#   2. Month validation: 0, 13 → 400
#   3. Default (current year) — no month filter
#   4. Specific year + month
#   5. Response headers: Content-Type, Content-Disposition,
#      X-GoBD-Stats, X-GoBD-Generation-Ms
#   6. ZIP file integrity: starts with PK\x03\x04
#   7. Missing companyId → 400

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

login

YEAR=$(date +%Y)
MONTH=$(date +%-m)

# ========== Test 1: Year validation 1999 → 400 ==========
api_get "/api/v1/gobd-export?companyId=$COMPANY_ID&year=1999"
assert_eq "year=1999 → 400" "$STATUS" "400"

# ========== Test 2: Year validation 2101 → 400 ==========
api_get "/api/v1/gobd-export?companyId=$COMPANY_ID&year=2101"
assert_eq "year=2101 → 400" "$STATUS" "400"

# ========== Test 3: Month validation 0 → 400 ==========
api_get "/api/v1/gobd-export?companyId=$COMPANY_ID&year=$YEAR&month=0"
assert_eq "month=0 → 400" "$STATUS" "400"

# ========== Test 4: Month validation 13 → 400 ==========
api_get "/api/v1/gobd-export?companyId=$COMPANY_ID&year=$YEAR&month=13"
assert_eq "month=13 → 400" "$STATUS" "400"

# ========== Test 5: Missing companyId → 400 ==========
api_get "/api/v1/gobd-export?year=$YEAR"
assert_eq "missing companyId → 400" "$STATUS" "400"

# ========== Test 6: Default (current year, no month) ==========
api_get "/api/v1/gobd-export?companyId=$COMPANY_ID&year=$YEAR"
# HEADERS file is written by curl when -D - is used
# via api_get. We need a separate raw curl to capture
# the binary ZIP.
ZIP_TMP="/tmp/gobd-export-test-$YEAR.zip"
HTTP_STATUS=$(curl -sS -o "$ZIP_TMP" -D /tmp/gobd-headers.txt -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/gobd-export?companyId=$COMPANY_ID&year=$YEAR")
assert_eq "default GET status" "$HTTP_STATUS" "200"

# ========== Test 7: Content-Type header ==========
CT=$(grep -i "^content-type:" /tmp/gobd-headers.txt | tr -d '\r' | head -1)
if [[ "$CT" == *"application/zip"* ]]; then
  pass "Content-Type is application/zip: $CT"
else
  fail "expected application/zip, got: $CT"
fi

# ========== Test 8: Content-Disposition header ==========
CD=$(grep -i "^content-disposition:" /tmp/gobd-headers.txt | tr -d '\r' | head -1)
if [[ "$CD" == *"attachment"* ]] && [[ "$CD" == *".zip"* ]]; then
  pass "Content-Disposition has attachment + .zip: $CD"
else
  fail "Content-Disposition missing attachment/.zip: $CD"
fi

# ========== Test 9: X-GoBD-Stats header ==========
STATS=$(grep -i "^x-gobd-stats:" /tmp/gobd-headers.txt | tr -d '\r' | head -1)
if [[ -n "$STATS" ]]; then
  pass "X-GoBD-Stats present: ${STATS:0:80}..."
else
  fail "X-GoBD-Stats header missing"
fi

# ========== Test 10: X-GoBD-Generation-Ms header ==========
GENMS=$(grep -i "^x-gobd-generation-ms:" /tmp/gobd-headers.txt | tr -d '\r' | head -1)
if [[ -n "$GENMS" ]]; then
  pass "X-GoBD-Generation-Ms present: $GENMS"
else
  fail "X-GoBD-Generation-Ms header missing"
fi

# ========== Test 11: ZIP file starts with PK\x03\x04 ==========
if [[ -s "$ZIP_TMP" ]]; then
  FIRST_BYTES=$(xxd -p -l 4 "$ZIP_TMP" 2>/dev/null || head -c 4 "$ZIP_TMP" | od -An -tx1 | tr -d ' \n')
  if [[ "$FIRST_BYTES" == "504b0304" ]]; then
    pass "ZIP magic bytes correct (PK\\x03\\x04)"
  else
    fail "expected ZIP magic 504b0304, got: $FIRST_BYTES"
  fi
  ZIP_SIZE=$(wc -c < "$ZIP_TMP")
  note "ZIP size: $ZIP_SIZE bytes"
else
  fail "ZIP file is empty"
fi

# ========== Test 12: Specific year + month ==========
if [[ "$MONTH" -ge 1 && "$MONTH" -le 12 ]]; then
  HTTP_STATUS=$(curl -sS -o /tmp/gobd-export-month.zip -w "%{http_code}" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    "$API/api/v1/gobd-export?companyId=$COMPANY_ID&year=$YEAR&month=$MONTH")
  assert_eq "specific month GET status" "$HTTP_STATUS" "200"
fi

# ========== Cleanup ==========
rm -f "$ZIP_TMP" /tmp/gobd-export-month.zip /tmp/gobd-headers.txt
pass "cleanup complete (tmp files)"

summary
