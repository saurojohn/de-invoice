#!/bin/bash
# Test 11: Storno (Korrekturbeleg) in DATEV export
# - Storno Voucher (referenceType=VoucherReversal)
#   appears in the DATEV export for the date range
#   covering the Storno's correction date
# - The Storno's Belegfeld 2 (column 4) contains the
#   ORIGINAL voucher number, NOT the enum label
#   "VoucherReversal" — the Berater needs the original
#   number to pivot
# - Original voucher rows still have Belegfeld 2 =
#   "Manual" (their referenceType)
# - 2-line Storno emits 2 DATEV rows (Soll + Haben),
#   amounts equal the original's, Soll/Haben swapped

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Cleanup any prior test data
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-DT-%' OR \"voucherNumber\" LIKE 'VND-DT-%-S%');
   DELETE FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-DT-%' OR \"voucherNumber\" LIKE 'VND-DT-%-S%';" >/dev/null 2>&1

# Capture the baseline sum of account 4900 BEFORE the
# test creates its own data. The Storno + original pair
# this test creates will net to 0 on account 4900 —
# we use baseline-snapshot (capture the SUM, then
# assert the SUM-after equals the SUM-before).
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/datev-vnd-dt-before.csv
NET_4900_BEFORE=$(awk -F';' 'NR>1 && $7 == 4900 {if ($6 == "S") sum += $8; else sum -= $8} END {printf "%.2f\n", sum}' /tmp/datev-vnd-dt-before.csv)
note "baseline sum account 4900 = $NET_4900_BEFORE (before test)"

echo "=== Test: Storno in DATEV export ==="

A4900=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='4900';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1200=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1200';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)

# Create original in MAY (so the Storno in June is in a
# DIFFERENT month — proves the export treats each by
# its own date)
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-05-15\",
  \"description\": \"VND-DT Original\",
  \"referenceType\": \"Manual\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 400, \"credit\": 0 },
    { \"accountId\": \"$A1200\", \"debit\": 0, \"credit\": 400 }
  ]
}" >/dev/null
assert_eq "create May original HTTP" "$STATUS" "201"
ORIG_NUM=$(json_field "$BODY" voucherNumber)
ORIG_ID=$(json_field "$BODY" id)
[ -n "$ORIG_ID" ] && echo "✓ original id = $ORIG_ID ($ORIG_NUM)" || { echo "✗ no id"; exit 1; }

# Create Storno (date = today)
api_post "/api/v1/accounting/vouchers/$ORIG_ID/reversal?companyId=$COMPANY_ID" '{
  "reason": "DATEV test"
}' >/dev/null
assert_eq "create Storno HTTP" "$STATUS" "201"
STO_NUM=$(json_field "$BODY" voucherNumber)
STO_ID=$(json_field "$BODY" id)
[ -n "$STO_ID" ] && echo "✓ Storno id = $STO_ID ($STO_NUM)" || { echo "✗ no id"; exit 1; }

# DATEV export for the WHOLE YEAR — both vouchers in
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/datev-vnd-dt.csv
echo "DATEV export size: $(wc -l < /tmp/datev-vnd-dt.csv) lines"

# Test 1: original appears
if file_contains "$ORIG_NUM" /tmp/datev-vnd-dt.csv; then
  echo "✓ original $ORIG_NUM in DATEV export"
else
  fail "original $ORIG_NUM missing from DATEV export"
fi

# Test 2: Storno appears
if file_contains "$STO_NUM" /tmp/datev-vnd-dt.csv; then
  echo "✓ Storno $STO_NUM in DATEV export"
else
  fail "Storno $STO_NUM missing from DATEV export"
fi

# DATEV pads Belegfeld 1 to 36 chars with trailing spaces
# — awk $3 == "BK-..." exact-match would fail. Strip
# trailing whitespace from column 3 first via sub().
#
# Test 3: Storno Belegfeld 2 (column 4) = original voucher
# number. Pre-fix it was the enum "VoucherReversal" —
# useless to the Berater.
STO_BF2=$(awk -F';' -v sn="$STO_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == sn) {sub(/ +$/, "", $4); print $4; exit}}' /tmp/datev-vnd-dt.csv)
assert_eq "Storno Belegfeld 2 = original voucher number" "$STO_BF2" "$ORIG_NUM"

# Test 4: original Belegfeld 2 (column 4) = "Manual"
# (the referenceType — distinct from the Storno pivot)
ORIG_BF2=$(awk -F';' -v on="$ORIG_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == on) {sub(/ +$/, "", $4); print $4; exit}}' /tmp/datev-vnd-dt.csv)
assert_eq "original Belegfeld 2 = Manual" "$ORIG_BF2" "Manual"

# Test 5: 2 DATEV rows for the Storno
STO_ROW_COUNT=$(awk -F';' -v sn="$STO_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == sn) print}' /tmp/datev-vnd-dt.csv | wc -l)
assert_eq "Storno has 2 DATEV rows" "$(echo "$STO_ROW_COUNT" | tr -d ' ')" "2"

# Test 6: Storno's Soll/Haben are SWAPPED vs original
STO_SOLLS=$(awk -F';' -v sn="$STO_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == sn && $6 == "S") print $7}' /tmp/datev-vnd-dt.csv | sort -u | tr '\n' ',' | sed 's/,$//')
STO_HABENS=$(awk -F';' -v sn="$STO_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == sn && $6 == "H") print $7}' /tmp/datev-vnd-dt.csv | sort -u | tr '\n' ',' | sed 's/,$//')
assert_eq "Storno Soll accounts" "$STO_SOLLS" "1200"
assert_eq "Storno Haben accounts" "$STO_HABENS" "4900"

# Test 7: amounts equal between Storno and original
ORIG_AMT=$(awk -F';' -v on="$ORIG_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == on) {print $8; exit}}' /tmp/datev-vnd-dt.csv)
STO_AMT=$(awk -F';' -v sn="$STO_NUM" 'NR>1 {sub(/ +$/, "", $3); if ($3 == sn) {print $8; exit}}' /tmp/datev-vnd-dt.csv)
assert_eq "Storno amount = original amount" "$STO_AMT" "$ORIG_AMT"

# Test 8: net effect on 4900 across the year is zero
# Sum Storno's debit rows on 4900 (which is Haben in our
# Soll/Haben semantics since Storno swapped). The shared
# DB has accumulated 4900 entries from prior tests —
# we use baseline-snapshot: capture the SUM before the
# test creates its own data, then assert the SUM-after
# equals SUM-before (the Storno fully reverses the
# original, net contribution = 0).
NET_4900=$(awk -F';' 'NR>1 && $7 == 4900 {if ($6 == "S") sum += $8; else sum -= $8} END {printf "%.2f\n", sum}' /tmp/datev-vnd-dt.csv)
# Captured earlier as NET_4900_BEFORE (after cleaning
# the test's previous runs, before creating new data)
[ "$NET_4900" = "$NET_4900_BEFORE" ] && echo "✓ net effect on 4900 across year = $NET_4900 (Storno fully reverses original, baseline-snapshot)" || { echo "✗ net 4900 expected=$NET_4900_BEFORE actual=$NET_4900"; exit 1; }

# Test 9: date filter on May ONLY — Storno should NOT appear
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-05-01&endDate=2026-05-31" \
  -o /tmp/datev-may-only.csv
if file_contains "$STO_NUM" /tmp/datev-may-only.csv; then
  fail "Storno $STO_NUM should NOT be in May-only export (Storno is dated today)"
else
  echo "✓ Storno correctly absent from May-only export"
fi
if ! file_contains "$ORIG_NUM" /tmp/datev-may-only.csv; then
  fail "Original $ORIG_NUM should be in May-only export"
else
  echo "✓ Original correctly present in May-only export"
fi

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-DT-%' OR \"voucherNumber\" LIKE 'VND-DT-%-S%');
   DELETE FROM \"Voucher\" WHERE \"voucherNumber\" LIKE 'VND-DT-%' OR \"voucherNumber\" LIKE 'VND-DT-%-S%';" >/dev/null 2>&1
mavis-trash /tmp/datev-vnd-dt.csv /tmp/datev-may-only.csv 2>/dev/null

echo
echo "ALL PASSED"
