#!/usr/bin/env bash
# e2e 115: Tier 89 — Monthly AfA-Buchung.
#
# Validates the new POST /api/v1/assets/book-afa-monthly
# endpoint. Tier 89 adds an alternate booking
# mode that creates 12 monthly rows per asset
# (one per month, dated last day of the month)
# instead of 1 year-end row. This makes the
# BWA 3100 line show real booked AfA in each
# month instead of a single December spike.
#
# Tests:
#   1. /book-afa-monthly creates 12 rows per asset
#      (bookedCount = 1 asset × 12 months = 12)
#   2. Total = 12 * monthlyAfA = annualAfA
#   3. Each row has afaMonth set (1..12) + afaYear
#   4. /booking-status returns bookingMode='monthly'
#   5. BWA 3100 monat for July = -monthlyAfA (not -annualAfA)
#   6. BWA 3100 YTD for July = -7*monthlyAfA
#   7. BWA 3100 YTD for December = -12*monthlyAfA = -annualAfA
#   8. /book-afa (annual) refused with 400 because
#      monthly booking already exists (mutex).
#   9. /book-afa-monthly is idempotent (2nd call
#      bookedCount=0, skippedAlreadyCount=12).
#  10. After storno (DELETE all AfA rows for the
#      year), /book-afa (annual) succeeds.
#  11. /booking-status returns bookingMode='annual'
#      after the annual booking.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="afam-tier89-$TS"
echo "=== Test: AfA monatlich (test tag: $TEST_TAG) ==="

# Pre-cleanup: any leftover AfA from previous runs
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T89-${TS}-%');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T89-${TS}-%';" >/dev/null 2>&1

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T89-${TS}-%');" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T89-${TS}-%';" >/dev/null 2>&1
  echo "  cleanup: removed T89-${TS}-* rows"
}
trap cleanup EXIT

# ===== Seed =====
# 1 Asset: 12000 EUR / 60 months / 2026-01-01
# annualAfA = 12000 / 60 * 12 = 2400
# monthlyAfA = 2400 / 12 = 200
TMP_SQL=$(mktemp -t afam-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Asset" (id, "companyId", type, bezeichnung, "anschaffungsDatum", "anschaffungsKosten", "nutzungsdauerMonate", restwert, "afaMethode", "bilanzKonto", notiz, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'Maschine', 'T89-${TS}-Maschine', '2026-01-01', 12000, 60, 0, 'linear', '0300', NULL, now(), now());
EOF
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
ASSET_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Asset\" WHERE \"companyId\"='$COMPANY_ID' AND bezeichnung='T89-${TS}-Maschine';" \
  2>&1 | tr -d ' ' | head -1)
echo "  created asset $ASSET_ID (annualAfA=2400, monthlyAfA=200)"

# ===== 1. /book-afa-monthly creates 12 rows =====
echo
echo "=== 1. POST /assets/book-afa-monthly ==="
RESULT=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa-monthly?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
MODE=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['mode'])")
BOOKED_COUNT=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
TOTAL=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalAnnualAfA'])")
assert_eq "mode = monthly" "$MODE" "monthly"
assert_eq "bookedCount = 12 (1 asset × 12 months)" "$BOOKED_COUNT" "12"
assert_eq "total = 2400" "$TOTAL" "2400"

# ===== 2. DB shape: each row has afaMonth set =====
echo
echo "=== 2. Booked AfA rows in DB (12 rows, afaMonth 1..12) ==="
DB_SHAPE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
SELECT
  COUNT(*) || '|' ||
  COUNT(*) FILTER (WHERE \"afaMonth\" IS NOT NULL) || '|' ||
  COUNT(*) FILTER (WHERE \"afaMonth\" BETWEEN 1 AND 12) || '|' ||
  SUM(\"grossAmount\")
FROM \"Expense\"
WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA' AND \"afaYear\"=2026;" 2>&1 | tr -d ' ')
ROW_COUNT=$(echo "$DB_SHAPE" | cut -d'|' -f1)
WITH_MONTH=$(echo "$DB_SHAPE" | cut -d'|' -f2)
VALID_MONTH=$(echo "$DB_SHAPE" | cut -d'|' -f3)
SUM_GROSS=$(echo "$DB_SHAPE" | cut -d'|' -f4)
assert_eq "row count = 12" "$ROW_COUNT" "12"
assert_eq "rows with afaMonth set" "$WITH_MONTH" "12"
assert_eq "rows with valid afaMonth (1-12)" "$VALID_MONTH" "12"
assert_eq "sum of grossAmount = -2400" "$SUM_GROSS" "-2400.0000"

# ===== 3. Per-month check: 12 rows, one per month =====
echo
echo "=== 3. Per-month AfA rows (200 each) ==="
PER_MONTH=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
SELECT
  \"afaMonth\" || '|' || \"grossAmount\"
FROM \"Expense\"
WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA' AND \"afaYear\"=2026
ORDER BY \"afaMonth\";" 2>&1 | tr -d ' ')
ROW_JAN=$(echo "$PER_MONTH" | head -1)
ROW_DEC=$(echo "$PER_MONTH" | tail -1)
MONTH_JAN=$(echo "$ROW_JAN" | cut -d'|' -f1)
AMT_JAN=$(echo "$ROW_JAN" | cut -d'|' -f2)
MONTH_DEC=$(echo "$ROW_DEC" | cut -d'|' -f1)
AMT_DEC=$(echo "$ROW_DEC" | cut -d'|' -f2)
assert_eq "Jan row afaMonth = 1" "$MONTH_JAN" "1"
assert_eq "Jan row grossAmount = -200" "$AMT_JAN" "-200.0000"
assert_eq "Dec row afaMonth = 12" "$MONTH_DEC" "12"
assert_eq "Dec row grossAmount = -200" "$AMT_DEC" "-200.0000"

# ===== 4. /booking-status returns bookingMode='monthly' =====
echo
echo "=== 4. /booking-status bookingMode = 'monthly' ==="
STATUS_MODE=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET_ID':
    print(r['bookingMode'])
    break
")
assert_eq "bookingMode = monthly" "$STATUS_MODE" "monthly"

# ===== 5. BWA 3100 monat for July = -200 (NOT -2400) =====
echo
echo "=== 5. BWA 3100 monthly view (July) ==="
BWA_JUL=$(curl -sS \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=7" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['lines']:
  if l['bucket']=='3100':
    print(f\"{l['monat']}|{l['ytd']}\")
    break
")
BWA_JUL_MONAT=$(echo "$BWA_JUL" | cut -d'|' -f1)
BWA_JUL_YTD=$(echo "$BWA_JUL" | cut -d'|' -f2)
# Tier 361: these expected AfA as a negative BWA line. That was true when
# Tier 87 summed the (negative) AfA expense amounts as-is; bwa.service.ts
# now sums .abs() and subtracts AfA in betriebsergebnis like every other
# cost bucket (112-tier86-bwa and 119-tier93-bwa-extensions expect positive
# costs and pass). The spec never ran, so it never followed.
assert_eq "BWA Jul monat = 200" "$BWA_JUL_MONAT" "200"
assert_eq "BWA Jul YTD = 1400 (7 months)" "$BWA_JUL_YTD" "1400"

# ===== 6. BWA 3100 monat for December = -200 (not -2400) =====
echo
echo "=== 6. BWA 3100 monthly view (December) ==="
BWA_DEC=$(curl -sS \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=12" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['lines']:
  if l['bucket']=='3100':
    print(f\"{l['monat']}|{l['ytd']}\")
    break
")
BWA_DEC_MONAT=$(echo "$BWA_DEC" | cut -d'|' -f1)
BWA_DEC_YTD=$(echo "$BWA_DEC" | cut -d'|' -f2)
assert_eq "BWA Dec monat = 200 (NOT 2400)" "$BWA_DEC_MONAT" "200"
assert_eq "BWA Dec YTD = 2400 (12 months)" "$BWA_DEC_YTD" "2400"

# ===== 7. /book-afa (annual) refused because monthly already exists =====
echo
echo "=== 7. /book-afa (annual) mutex with monthly ==="
STATUS_ANNUAL=$(curl -sS -o /tmp/annual-resp.json -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
ANNUAL_MSG=$(python3 -c "import json; print(json.load(open('/tmp/annual-resp.json'))['message'])" 2>/dev/null | head -1)
assert_eq "annual /book-afa → 400" "$STATUS_ANNUAL" "400"
case "$ANNUAL_MSG" in
  *"monatlich"*) echo "✓ error message mentions 'monatlich'" ;;
  *) echo "✗ error message missing 'monatlich': $ANNUAL_MSG"; exit 1 ;;
esac
rm -f /tmp/annual-resp.json

# ===== 8. /book-afa-monthly is idempotent (2nd call = 0 booked) =====
echo
echo "=== 8. /book-afa-monthly idempotency ==="
RESULT2=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa-monthly?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BOOKED2=$(echo "$RESULT2" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
SKIPPED2=$(echo "$RESULT2" | python3 -c "import json,sys; print(json.load(sys.stdin)['skippedAlreadyCount'])")
assert_eq "2nd call bookedCount = 0" "$BOOKED2" "0"
assert_eq "2nd call skippedAlreadyCount = 12" "$SKIPPED2" "12"

# ===== 9. Storno the monthly booking, then annual booking succeeds =====
echo
echo "=== 9. Storno monthly → annual booking succeeds ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T89-${TS}-%');" >/dev/null 2>&1
RESULT3=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BOOKED3=$(echo "$RESULT3" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
MODE3=$(echo "$RESULT3" | python3 -c "import json,sys; print(json.load(sys.stdin)['mode'])")
assert_eq "annual after storno: bookedCount = 1" "$BOOKED3" "1"
assert_eq "annual after storno: mode = annual" "$MODE3" "annual"

# ===== 10. /booking-status now shows bookingMode='annual' =====
echo
echo "=== 10. /booking-status bookingMode = 'annual' after annual booking ==="
STATUS_MODE_ANNUAL=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET_ID':
    print(r['bookingMode'])
    break
")
assert_eq "bookingMode = annual" "$STATUS_MODE_ANNUAL" "annual"

# ===== 11. /book-afa-monthly now refused because annual already exists =====
echo
echo "=== 11. /book-afa-monthly mutex with annual ==="
STATUS_MONTHLY=$(curl -sS -o /tmp/monthly-resp.json -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa-monthly?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
MONTHLY_MSG=$(python3 -c "import json; print(json.load(open('/tmp/monthly-resp.json'))['message'])" 2>/dev/null | head -1)
assert_eq "monthly /book-afa-monthly → 400" "$STATUS_MONTHLY" "400"
case "$MONTHLY_MSG" in
  *"jährlich"*) echo "✓ error message mentions 'jährlich'" ;;
  *) echo "✗ error message missing 'jährlich': $MONTHLY_MSG"; exit 1 ;;
esac
rm -f /tmp/monthly-resp.json

# ===== 12. Year validation =====
echo
echo "=== 12. year=1999 → 400 ==="
STATUS_YEAR=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa-monthly?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_YEAR" "400"

# ===== 13. Missing companyId =====
echo
echo "=== 13. Missing companyId → 400 ==="
STATUS_NOCO=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa-monthly?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$STATUS_NOCO" "400"

echo
summary
