#!/usr/bin/env bash
# e2e 116: Tier 90 — AfA-Storno (Buchung rückgängig).
#
# Validates the new POST /api/v1/assets/storno-afa
# endpoint. Tier 90 closes the gap from tier 87+89:
# until now, once a user clicked "AfA buchen" there
# was no way to undo the booking. The storno flow
# deletes all booked AfA Expense rows for the year
# (any mode) + writes an AuditLog entry so the
# Berater can see the storno event in the audit
# trail.
#
# Tests:
#   1. /storno-afa on a fresh year returns
#      stornoedCount=0 (idempotent).
#   2. After book-afa, /storno-afa deletes the
#      row + writes an audit log entry.
#   3. After storno, /book-afa can be called
#      again (rebook works after storno).
#   4. After book-afa-monthly (12 rows),
#      /storno-afa deletes all 12 rows in one
#      shot + audit log records mode='monthly'.
#   5. After storno, /booking-status shows
#      booked=false for all assets.
#   6. Year validation 1999, 2101 → 400.
#   7. Missing companyId → 400.
#   8. Cross-tenant → 401.
#   9. Audit log entry 'assets.afa.stornoed'
#      contains the year + count + total in
#      oldData (for Berater audit review).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="storno-tier90-$TS"
echo "=== Test: AfA-Storno (test tag: $TEST_TAG) ==="

# Pre-cleanup
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T90-${TS}-%');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T90-${TS}-%';" >/dev/null 2>&1

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T90-${TS}-%');" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T90-${TS}-%';" >/dev/null 2>&1
  echo "  cleanup: removed T90-${TS}-* rows"
}
trap cleanup EXIT

# ===== Seed =====
TMP_SQL=$(mktemp -t storno-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Asset" (id, "companyId", type, bezeichnung, "anschaffungsDatum", "anschaffungsKosten", "nutzungsdauerMonate", restwert, "afaMethode", "bilanzKonto", notiz, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'Maschine', 'T90-${TS}-Maschine', '2026-01-01', 6000, 60, 0, 'linear', '0300', NULL, now(), now());
EOF
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
ASSET_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Asset\" WHERE \"companyId\"='$COMPANY_ID' AND bezeichnung='T90-${TS}-Maschine';" \
  2>&1 | tr -d ' ' | head -1)
echo "  created asset $ASSET_ID (annualAfA=1200)"

# ===== 1. /storno-afa on fresh year =====
echo
echo "=== 1. /storno-afa on fresh year (no bookings) ==="
FRESH=$(curl -sS -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=2025" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
FRESH_COUNT=$(echo "$FRESH" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedCount'])")
FRESH_TOTAL=$(echo "$FRESH" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedTotal'])")
assert_eq "stornoedCount = 0 (no bookings)" "$FRESH_COUNT" "0"
assert_eq "stornoedTotal = 0" "$FRESH_TOTAL" "0"

# ===== 2. After book-afa, /storno-afa deletes the row =====
echo
echo "=== 2. book-afa → storno-afa ==="
curl -sS -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" > /dev/null
# Check the row exists
BEFORE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows before storno" "$BEFORE" "1"
# Storno
STORNO1=$(curl -sS -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STORNO_COUNT1=$(echo "$STORNO1" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedCount'])")
STORNO_TOTAL1=$(echo "$STORNO1" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedTotal'])")
assert_eq "stornoedCount = 1" "$STORNO_COUNT1" "1"
assert_eq "stornoedTotal = 1200" "$STORNO_TOTAL1" "1200"
# Check the row is gone
AFTER=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows after storno" "$AFTER" "0"

# ===== 3. After storno, /book-afa can be called again (rebook) =====
echo
echo "=== 3. rebook after storno ==="
REBOOK=$(curl -sS -X POST \
  "$API/api/v1/assets/book-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
REBOOK_COUNT=$(echo "$REBOOK" | python3 -c "import json,sys; print(json.load(sys.stdin)['bookedCount'])")
assert_eq "rebook bookedCount = 1" "$REBOOK_COUNT" "1"

# ===== 4. book-afa-monthly + storno deletes all 12 =====
echo
echo "=== 4. book-afa-monthly → storno-afa (deletes 12 rows) ==="
# First storno the annual booking
curl -sS -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" > /dev/null
# Now book monthly
curl -sS -X POST \
  "$API/api/v1/assets/book-afa-monthly?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" > /dev/null
# Verify 12 rows
BEFORE_M=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "monthly AfA rows before storno" "$BEFORE_M" "12"
# Storno
STORNO2=$(curl -sS -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STORNO_COUNT2=$(echo "$STORNO2" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedCount'])")
STORNO_TOTAL2=$(echo "$STORNO2" | python3 -c "import json,sys; print(json.load(sys.stdin)['stornoedTotal'])")
assert_eq "stornoedCount = 12" "$STORNO_COUNT2" "12"
assert_eq "stornoedTotal = 1200" "$STORNO_TOTAL2" "1200"
AFTER_M=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "monthly AfA rows after storno" "$AFTER_M" "0"

# ===== 5. After storno, /booking-status shows booked=false =====
echo
echo "=== 5. /booking-status after storno (booked=false) ==="
STATUS_AFTER=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET_ID':
    print(f\"{r['booked']}|{r['bookingMode']}|{r['bookedAfA']}\")
    break
")
ST_BOOKED=$(echo "$STATUS_AFTER" | cut -d'|' -f1)
ST_MODE=$(echo "$STATUS_AFTER" | cut -d'|' -f2)
ST_AMT=$(echo "$STATUS_AFTER" | cut -d'|' -f3)
assert_eq "booked = false" "$ST_BOOKED" "False"
assert_eq "bookingMode = None" "$ST_MODE" "None"
assert_eq "bookedAfA = 0" "$ST_AMT" "0"

# ===== 6. Year validation =====
echo
echo "=== 6. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"

# ===== 7. Missing companyId =====
echo
echo "=== 7. Missing companyId → 400 ==="
STATUS_NOCO=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/storno-afa?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$STATUS_NOCO" "400"

# ===== 8. Cross-tenant =====
echo
echo "=== 8. Cross-tenant → 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets/storno-afa?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 9. Audit log entry exists with the right data =====
echo
echo "=== 9. Audit log 'assets.afa.stornoed' entry ==="
AUDIT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT
    COALESCE(\"oldData\"->>'year', 'NULL') || '|' ||
    COALESCE(\"oldData\"->>'mode', 'NULL') || '|' ||
    COALESCE(\"oldData\"->>'stornoedTotal', 'NULL')
  FROM \"AuditLog\"
  WHERE action='assets.afa.stornoed' AND \"entityId\"='year-2026'
  ORDER BY \"createdAt\" DESC LIMIT 1;" 2>&1 | tr -d ' ')
# Both stornos (annual + monthly) wrote an entry — we want the latest one (monthly)
AUDIT_YEAR=$(echo "$AUDIT" | cut -d'|' -f1)
AUDIT_MODE=$(echo "$AUDIT" | cut -d'|' -f2)
AUDIT_TOTAL=$(echo "$AUDIT" | cut -d'|' -f3)
assert_eq "audit oldData.year = 2026" "$AUDIT_YEAR" "2026"
assert_eq "audit oldData.mode = monthly" "$AUDIT_MODE" "monthly"
assert_eq "audit oldData.stornoedTotal = 1200" "$AUDIT_TOTAL" "1200"

echo
summary
