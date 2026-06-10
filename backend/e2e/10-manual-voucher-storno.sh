#!/bin/bash
# Test 10: Manual Voucher + Storno (GoBD Korrekturbeleg)
# - POST a manual Voucher with N lines, must be balanced
#   to succeed (Soll = Haben); otherwise 400
# - Storno (POST /vouchers/:id/reversal) creates a NEW
#   voucher with the same accounts but Soll ↔ Haben
#   swapped, suffix -S1 on voucherNumber
# - Original voucher NOT mutated (still status=posted,
#   still has the original lines, still no
#   referenceType=VoucherReversal)
# - Storno is idempotent: a second call returns the
#   same Storno, not a duplicate
# - Cannot Storno a Storno (chain of reversals rejected)
# - findOne includes the reversals back-relation
# - The original's findOne now contains the Storno in
#   `reversals` so the detail page can surface it

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Wipe prior test data
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-MAN-%' OR \"voucherNumber\" LIKE 'VND-MAN-%-S%');
   DELETE FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-MAN-%' OR \"voucherNumber\" LIKE 'VND-MAN-%-S%';" >/dev/null 2>&1

echo "=== Test: manual voucher + GoBD Storno ==="

# Look up account ids (4900 Aufwand + 1200 Bank, both seeded)
A4900=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='4900';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1200=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1200';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)

# Test 1: create a manual voucher (balanced, 2 lines)
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-06-10\",
  \"description\": \"E2E Manual Test\",
  \"referenceType\": \"Manual\",
  \"status\": \"posted\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 250, \"credit\": 0, \"description\": \"Aufwand\" },
    { \"accountId\": \"$A1200\", \"debit\": 0, \"credit\": 250, \"description\": \"Bank\" }
  ]
}" >/dev/null
assert_eq "create manual voucher HTTP" "$STATUS" "201"
VCH_NUM=$(json_field "$BODY" voucherNumber)
VCH_ID=$(json_field "$BODY" id)
VCH_STATUS=$(json_field "$BODY" status)
VCH_REFTYPE=$(json_field "$BODY" referenceType)
assert_eq "voucherNumber is VND-MAN-style or BK-…" \
  "$(echo "$VCH_NUM" | grep -E '^(VND-MAN-|BK-)' )" "$VCH_NUM"
assert_eq "manual voucher status" "$VCH_STATUS" "posted"
assert_eq "manual voucher referenceType" "$VCH_REFTYPE" "Manual"
[ -n "$VCH_ID" ] && echo "✓ voucher id returned = $VCH_ID" || { echo "✗ no id"; exit 1; }

# Test 2: unbalanced voucher is rejected (Soll 100, Haben 50)
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-06-10\",
  \"description\": \"unbalanced\",
  \"referenceType\": \"Manual\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 100, \"credit\": 0 },
    { \"accountId\": \"$A1200\", \"debit\": 0, \"credit\": 50 }
  ]
}" >/dev/null
assert_eq "unbalanced rejected" "$STATUS" "400"

# Test 3: Storno (reversal) creates a -S1 voucher with swapped lines
api_post "/api/v1/accounting/vouchers/$VCH_ID/reversal?companyId=$COMPANY_ID" '{
  "reason": "E2E Test — falscher Betrag"
}' >/dev/null
assert_eq "create reversal HTTP" "$STATUS" "201"
STO_NUM=$(json_field "$BODY" voucherNumber)
STO_REFTYPE=$(json_field "$BODY" referenceType)
STO_REVBY=$(json_field "$BODY" reversedById)
STO_DESC=$(json_field "$BODY" description)
assert_eq "Storno voucherNumber suffix -S1" \
  "$(echo "$STO_NUM" | grep -E '\-S1$')" "$STO_NUM"
assert_eq "Storno referenceType" "$STO_REFTYPE" "VoucherReversal"
assert_eq "Storno reversedById = original" "$STO_REVBY" "$VCH_ID"
assert_eq "Storno description includes Grund" \
  "$(echo "$STO_DESC" | grep -c "Grund:")" "1"

# Verify the Storno lines are SWAPPED (debit 0 / credit 250 vs debit 250 / credit 0)
# Prisma serializes Decimal as a string, but the format
# varies (sometimes "0", sometimes "0.0000") — normalize
# via float to be format-agnostic.
STO_4900=$(python3 -c "
import json,sys
d = json.loads(sys.argv[1])
for l in d['lines']:
    if l['account']['accountNumber'] == '4900':
        print(float(l['debit']), float(l['credit']))
" "$BODY")
assert_eq "Storno 4900 line swapped (debit 0, credit 250)" "$STO_4900" "0.0 250.0"

STO_1200=$(python3 -c "
import json,sys
d = json.loads(sys.argv[1])
for l in d['lines']:
    if l['account']['accountNumber'] == '1200':
        print(float(l['debit']), float(l['credit']))
" "$BODY")
assert_eq "Storno 1200 line swapped (debit 250, credit 0)" "$STO_1200" "250.0 0.0"

# Capture Storno id NOW — used by tests 6 + 7. We have
# to do this before test 4 because the next api_get will
# overwrite $BODY.
STO_ID=$(json_field "$BODY" id)

# Test 4: original voucher is NOT mutated (still status=posted, still 2 lines)
api_get "/api/v1/accounting/vouchers/$VCH_ID?companyId=$COMPANY_ID"
ORIG_STATUS=$(json_field "$BODY" status)
ORIG_REFTYPE=$(json_field "$BODY" referenceType)
ORIG_LINES=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['lines']))" "$BODY")
assert_eq "original status unchanged" "$ORIG_STATUS" "posted"
assert_eq "original referenceType unchanged" "$ORIG_REFTYPE" "Manual"
assert_eq "original still has 2 lines" "$ORIG_LINES" "2"

# Test 5: original's `reversals` back-relation now contains the Storno
ORIG_REV_LEN=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['reversals']))" "$BODY")
assert_eq "original reversals length = 1" "$ORIG_REV_LEN" "1"
ORIG_REV_NUM=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['reversals'][0]['voucherNumber'])" "$BODY")
assert_eq "original reversals[0].voucherNumber" "$ORIG_REV_NUM" "$STO_NUM"

# Test 6: idempotency — second reversal returns the same Storno
api_post "/api/v1/accounting/vouchers/$VCH_ID/reversal?companyId=$COMPANY_ID" '{
  "reason": "second click"
}' >/dev/null
assert_eq "second reversal HTTP" "$STATUS" "201"
SECOND_STO_ID=$(json_field "$BODY" id)
assert_eq "idempotent (same id as first Storno)" "$SECOND_STO_ID" "$STO_ID"

# Test 7: cannot reverse a Storno (chain rejected).
api_post "/api/v1/accounting/vouchers/$STO_ID/reversal?companyId=$COMPANY_ID" '{}' >/dev/null
assert_eq "reversing a Storno rejected" "$STATUS" "400"
ERR_MSG=$(json_field "$BODY" message)
assert_eq "chain rejection msg" \
  "$(echo "$ERR_MSG" | grep -c 'Storno nur vom Original')" "1"

# Test 8: existing 3-letter / 2-letter voucher list still works
api_get "/api/v1/accounting/vouchers?companyId=$COMPANY_ID&search=$STO_NUM"
SEARCH_TOTAL=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['total'])" "$BODY")
[ "$SEARCH_TOTAL" -ge 1 ] && echo "✓ Storno visible in list (search=$STO_NUM, total=$SEARCH_TOTAL)" || { echo "✗ Storno not in list"; exit 1; }

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-MAN-%' OR \"voucherNumber\" LIKE 'VND-MAN-%-S%');
   DELETE FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-MAN-%' OR \"voucherNumber\" LIKE 'VND-MAN-%-S%';" >/dev/null 2>&1

echo
echo "ALL PASSED"
