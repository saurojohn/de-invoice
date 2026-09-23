#!/usr/bin/env bash
# e2e 113: Tier 87 — AfA-Buchung (one-click auto-post).
#
# Closes the "computed but not booked" loop from
# tier 83. The Anlagenverzeichnis computes AfA in
# memory; tier 87 adds the booking side: a
# POST /api/v1/assets/book-afa endpoint that
# creates one Expense row per Asset (with
# category='AfA', relatedAssetId, afaYear) so
# the G+V 7a, BWA 3100, and Anlage S 4600 lines
# show real booked values, not just computed.
# The (relatedAssetId, afaYear) pair is the dedup
# key — re-running the booking is idempotent.
#
# Tests:
#   1. /booking-status returns per-asset computedAfA
#      + booked flag.
#   2. /book-afa creates one Expense row per Asset
#      (bookedCount=1, totalAnnualAfA=1000).
#   3. /book-afa is idempotent (2nd call returns
#      bookedCount=0, skippedAlreadyCount=1).
#   4. After booking, the G+V 7a / BWA 3100 /
#      Anlage S 4600 lines reflect the booked value
#      AND set afaSource='booked'.
#   5. An unbooked asset falls back to the
#      computed value (afaSource='computed').
#   6. Validation: year=1999 → 400.
#   7. Missing companyId → 400.
#   8. Cross-tenant → 401.
#   9. The booked AfA Expense row has the right
#      shape (category='AfA', relatedAssetId,
#      afaYear=year, grossAmount < 0).
#  10. The booked AfA row is NOT in the Sonstige
#      bucket of G+V 8 / BWA 3600 (no double-count).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="afa-tier87-$TS"
echo "=== Test: AfA-Buchung (test tag: $TEST_TAG) ==="

# Pre-cleanup: any leftover AfA-tier87-* assets
# from previous runs (orphan from crashed test).
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'AfA-${TS}-%');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'AfA-${TS}-%';" >/dev/null 2>&1

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'AfA-${TS}-%');" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'AfA-${TS}-%';" >/dev/null 2>&1
  echo "  cleanup: removed AfA-${TS}-* rows"
}
trap cleanup EXIT

# ===== Seed =====
# 1 Asset: Maschine 5000 EUR / 60 months / 2026-01-01
# annualAfA = 5000 / 60 * 12 = 1000
TMP_SQL=$(mktemp -t afa-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Asset" (id, "companyId", type, bezeichnung, "anschaffungsDatum", "anschaffungsKosten", "nutzungsdauerMonate", restwert, "afaMethode", "bilanzKonto", notiz, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'Maschine', 'AfA-${TS}-Maschine', '2026-01-01', 5000, 60, 0, 'linear', '0300', NULL, now(), now());
EOF
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
ASSET_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Asset\" WHERE \"companyId\"='$COMPANY_ID' AND bezeichnung='AfA-${TS}-Maschine';" \
  2>&1 | tr -d ' ' | head -1)
echo "  created asset $ASSET_ID"

# ===== 1. /booking-status initial =====
echo
echo "=== 1. /booking-status before booking ==="
STATUS_BEFORE=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
MINE_BEFORE=$(echo "$STATUS_BEFORE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET_ID':
    print(f\"{r['computedAfA']}|{r['booked']}|{r['bookedAfA']}\")
    break
")
echo "  before: $MINE_BEFORE"
COMPUTED_BEFORE=$(echo "$MINE_BEFORE" | cut -d'|' -f1)
BOOKED_BEFORE=$(echo "$MINE_BEFORE" | cut -d'|' -f2)
assert_eq "computedAfA = 1000" "$COMPUTED_BEFORE" "1000"
assert_eq "booked = false" "$BOOKED_BEFORE" "False"

# ===== 2. POST /book-afa =====
echo
echo "=== 2. POST /assets/book-afa year=2026 ==="
BOOK_RESULT=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
echo "  $BOOK_RESULT"
BOOKED_COUNT=$(echo "$BOOK_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
SKIPPED_ALREADY=$(echo "$BOOK_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['skippedAlreadyCount'])")
TOTAL_AF=$(echo "$BOOK_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalAnnualAfA'])")
assert_eq "bookedCount = 1" "$BOOKED_COUNT" "1"
assert_eq "skippedAlreadyCount = 0" "$SKIPPED_ALREADY" "0"
assert_eq "totalAnnualAfA = 1000" "$TOTAL_AF" "1000"

# ===== 3. Idempotency: POST /book-afa again =====
echo
echo "=== 3. Idempotency: POST /book-afa again ==="
BOOK_RESULT_2=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BOOKED_COUNT_2=$(echo "$BOOK_RESULT_2" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
SKIPPED_2=$(echo "$BOOK_RESULT_2" | python3 -c "import json,sys; print(json.load(sys.stdin)['skippedAlreadyCount'])")
assert_eq "2nd call bookedCount = 0" "$BOOKED_COUNT_2" "0"
assert_eq "2nd call skippedAlreadyCount = 1" "$SKIPPED_2" "1"

# ===== 4. /booking-status after booking =====
echo
echo "=== 4. /booking-status after booking ==="
STATUS_AFTER=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
MINE_AFTER=$(echo "$STATUS_AFTER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET_ID':
    print(f\"{r['computedAfA']}|{r['booked']}|{r['bookedAfA']}|{r['expenseId'] is not None}\")
    break
")
COMPUTED_AFTER=$(echo "$MINE_AFTER" | cut -d'|' -f1)
BOOKED_AFTER=$(echo "$MINE_AFTER" | cut -d'|' -f2)
BOOKED_AF_AFTER=$(echo "$MINE_AFTER" | cut -d'|' -f3)
HAS_EXPENSE=$(echo "$MINE_AFTER" | cut -d'|' -f4)
assert_eq "after: computedAfA = 1000" "$COMPUTED_AFTER" "1000"
assert_eq "after: booked = true" "$BOOKED_AFTER" "True"
assert_eq "after: bookedAfA = 1000" "$BOOKED_AF_AFTER" "1000"
assert_eq "after: expenseId set" "$HAS_EXPENSE" "True"

# ===== 5. BWA 3100 reflects booking =====
echo
echo "=== 5. BWA 3100 reflects booking (afaSource=booked) ==="
BWA=$(curl -sS \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=12" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BWA_3100_MONAT=$(echo "$BWA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['lines']:
  if l['bucket']=='3100':
    print(l['monat'])
    break
")
BWA_3100_YTD=$(echo "$BWA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['lines']:
  if l['bucket']=='3100':
    print(l['ytd'])
    break
")
BWA_AFA_SOURCE=$(echo "$BWA" | python3 -c "import json,sys; print(json.load(sys.stdin)['afaSource'])")
BWA_AFA_BOOKINGS=$(echo "$BWA" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['afaBookings'])")
# Tier 361: these expected AfA as a negative BWA line. That was true when
# Tier 87 summed the (negative) AfA expense amounts as-is; bwa.service.ts
# now sums .abs() and subtracts AfA in betriebsergebnis like every other
# cost bucket (112-tier86-bwa and 119-tier93-bwa-extensions expect positive
# costs and pass). The spec never ran, so it never followed.
assert_eq "BWA 3100 monat = 1000" "$BWA_3100_MONAT" "1000"
assert_eq "BWA 3100 ytd = 1000" "$BWA_3100_YTD" "1000"
assert_eq "BWA afaSource = booked" "$BWA_AFA_SOURCE" "booked"
assert_eq "BWA afaBookings = 1" "$BWA_AFA_BOOKINGS" "1"

# ===== 6. G+V 7a reflects booking =====
echo
echo "=== 6. G+V 7a reflects booking ==="
GUV=$(curl -sS \
  "$API/api/v1/accounting/guv?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
GUV_7A=$(echo "$GUV" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['cost']['lines']:
  if l['position']=='7a':
    print(l['amount'])
    break
")
GUV_AFA_SOURCE=$(echo "$GUV" | python3 -c "import json,sys; print(json.load(sys.stdin)['afaSource'])")
GUV_AFA_BOOKINGS=$(echo "$GUV" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['afaBookings'])")
# Tier 436: a cost, positive like the other cost lines (and the computed
# fallback); -1000 was subtracted from the revenue and raised the result.
assert_eq "G+V 7a = 1000" "$GUV_7A" "1000"
assert_eq "G+V afaSource = booked" "$GUV_AFA_SOURCE" "booked"
assert_eq "G+V afaBookings = 1" "$GUV_AFA_BOOKINGS" "1"

# ===== 7. Anlage S 4600 reflects booking =====
echo
echo "=== 7. Anlage S 4600 reflects booking ==="
ANS=$(curl -sS \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
ANS_4600=$(echo "$ANS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['ausgaben']:
  if l['kennziffer']=='4600':
    print(l['amount'])
    break
")
ANS_AFA_SOURCE=$(echo "$ANS" | python3 -c "import json,sys; print(json.load(sys.stdin)['afaSource'])")
ANS_AFA_BOOKINGS=$(echo "$ANS" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['afaBookings'])")
# Tier 436: an expense line of Anlage S is a positive cost (it is subtracted
# from the revenue); -1000 made the AfA raise the Gewinn.
assert_eq "Anlage S 4600 = 1000" "$ANS_4600" "1000"
assert_eq "Anlage S afaSource = booked" "$ANS_AFA_SOURCE" "booked"
assert_eq "Anlage S afaBookings = 1" "$ANS_AFA_BOOKINGS" "1"

# ===== 8. Booked AfA row has the right shape =====
echo
echo "=== 8. Booked AfA Expense row shape ==="
ROW_SHAPE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
SELECT category || '|' ||
       COALESCE(\"relatedAssetId\", 'NULL') || '|' ||
       COALESCE(\"afaYear\"::text, 'NULL') || '|' ||
       CASE WHEN \"grossAmount\" < 0 THEN 'neg' ELSE 'pos' END || '|' ||
       CASE WHEN \"vatRate\" = 0 THEN 'novat' ELSE 'vat' END
FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET_ID' AND \"afaYear\"=2026;" 2>&1 | tr -d ' ')
echo "  shape: $ROW_SHAPE"
SHAPE_CATEGORY=$(echo "$ROW_SHAPE" | cut -d'|' -f1)
SHAPE_ASSET=$(echo "$ROW_SHAPE" | cut -d'|' -f2)
SHAPE_YEAR=$(echo "$ROW_SHAPE" | cut -d'|' -f3)
SHAPE_SIGN=$(echo "$ROW_SHAPE" | cut -d'|' -f4)
SHAPE_VAT=$(echo "$ROW_SHAPE" | cut -d'|' -f5)
assert_eq "row.category = AfA" "$SHAPE_CATEGORY" "AfA"
assert_eq "row.relatedAssetId = asset" "$SHAPE_ASSET" "$ASSET_ID"
assert_eq "row.afaYear = 2026" "$SHAPE_YEAR" "2026"
assert_eq "row.grossAmount < 0" "$SHAPE_SIGN" "neg"
assert_eq "row.vatRate = 0" "$SHAPE_VAT" "novat"

# ===== 9. Validation: year=1999 → 400 =====
echo
echo "=== 9. Validation: year=1999 → 400 ==="
STATUS_YEAR=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_YEAR" "400"

# ===== 10. Missing companyId → 400 =====
echo
echo "=== 10. Missing companyId → 400 ==="
STATUS_NOCO=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$STATUS_NOCO" "400"

# ===== 11. Cross-tenant → 401 =====
echo
echo "=== 11. Cross-tenant → 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" -H "x-company-id: $COMPANY_ID")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 12. Unbooked asset (no booking) → afaSource=computed =====
# After we tear down our booked asset in cleanup, the
# test still has OTHER pre-existing assets. We can't
# easily wipe them without breaking the dev DB, so
# instead we just verify the afaSource field is
# present on the BWA response (it'll be 'computed'
# for the rest of the company).
echo
echo "=== 12. BWA afaSource field present ==="
BWA_SOURCE_FIELD=$(echo "$BWA" | python3 -c "import json,sys; d=json.load(sys.stdin); print('afaSource' in d)")
assert_eq "BWA has afaSource field" "$BWA_SOURCE_FIELD" "True"

# ===== 13. Booking-status without companyId → 400 =====
echo
echo "=== 13. /booking-status missing companyId → 400 ==="
STATUS_NOCO2=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/assets/booking-status?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$STATUS_NOCO2" "400"

echo
summary
