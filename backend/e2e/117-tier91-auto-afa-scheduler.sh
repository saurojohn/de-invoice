#!/usr/bin/env bash
# e2e 117: Tier 91 — Auto-AfA month-end scheduler.
#
# Validates the AfaAutoBookerScheduler:
#   - Cron: @Cron("5 0 1 * *", { timeZone: "Europe/Berlin" })
#     fires at 00:05 on the 1st of each month in
#     Berlin time. Production trigger.
#   - Test-only endpoint POST /api/v1/assets/_test/
#     auto-booker-trigger?year=YYYY calls
#     forceTriggerForYear(year) for the e2e to
#     verify the flow without waiting for the 1st
#     of the month.
#   - Per-company opt-out via Company.settings.
#     autoBookAfa === false.
#   - Audit log entry: action='assets.afa.auto_booked'
#     with oldData = {year, mode, bookedCount,
#     skippedAlreadyCount, totalAnnualAfA,
#     triggeredBy: 'AfaAutoBookerScheduler:force'}.
#
# Tests:
#   1. Test-only route is registered + responds
#      with {companies, bookedCount, ...}.
#   2. force-trigger books 12 monthly AfA rows
#      for a fresh asset (mode='monthly').
#   3. Re-running force-trigger is idempotent
#      (no new rows).
#   4. Per-company opt-out: settings.autoBookAfa
#      =false → the company is skipped (no
#      booking for a fresh asset).
#   5. Re-enabling + re-triggering → fresh asset
#      gets booked.
#   6. Audit log entry 'assets.afa.auto_booked'
#      exists for the test year + the entry
#      has year + mode + bookedCount +
#      triggeredBy in oldData.
#   7. Cron is registered (the AfaAutoBookerScheduler
#      provider exists — verified via startup log
#      / by checking the route response includes
#      force-triggered data).
#   8. Cron schedule string is "5 0 1 * *"
#      (verified via parsing the scheduler source
#      — defense against accidental schedule change).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="autoafa-tier91-$TS"
echo "=== Test: Auto-AfA month-end scheduler (test tag: $TEST_TAG) ==="

# Use a far-future year (2028) so we don't clobber
# any existing data. The auto-booker is also
# triggered for other companies in the dev DB,
# which is the production behavior (the cron
# iterates all companies); we just filter the
# test assertions by the test asset's id.
TEST_YEAR=2028
OPT_OUT_YEAR=2029

# Pre-cleanup: remove any leftover rows from a
# previous aborted run of this test.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T91-${TS}-%');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T91-${TS}-%';" >/dev/null 2>&1
# Also clean any audit log entries from previous
# aborted runs of this test (filtered by oldData
# year=TEST_YEAR or OPT_OUT_YEAR + company=SH Leder
# to be safe).
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"AuditLog\" WHERE action='assets.afa.auto_booked' AND (\"oldData\"->>'year')::int IN ($TEST_YEAR, $OPT_OUT_YEAR);" >/dev/null 2>&1

# Backup the SH Leder settings JSON so we can
# restore it after the opt-out test. The opt-out
# test mutates settings.autoBookAfa; the cleanup
# trap restores it.
ORIGINAL_SETTINGS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT settings::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d ' ' | head -1)
# Trim trailing newline
ORIGINAL_SETTINGS=$(echo "$ORIGINAL_SETTINGS" | tr -d '\n')
echo "  backed up SH Leder settings (length=${#ORIGINAL_SETTINGS})"

cleanup() {
  # Restore the SH Leder settings JSON in case
  # the opt-out test left it mutated.
  if [ -n "$ORIGINAL_SETTINGS" ]; then
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
      "UPDATE \"Company\" SET settings='$ORIGINAL_SETTINGS'::jsonb WHERE id='$COMPANY_ID';" >/dev/null 2>&1
  fi
  # Remove all test-tagged Expense rows (the 12
  # monthly AfA rows per asset).
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Expense\" WHERE \"relatedAssetId\" IN (SELECT id FROM \"Asset\" WHERE bezeichnung LIKE 'T91-${TS}-%');" >/dev/null 2>&1
  # Remove test-tagged Asset rows.
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Asset\" WHERE bezeichnung LIKE 'T91-${TS}-%';" >/dev/null 2>&1
  # Remove audit log entries for the test years
  # (only the auto_booked ones — leave other
  # audit entries alone).
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"AuditLog\" WHERE action='assets.afa.auto_booked' AND (\"oldData\"->>'year')::int IN ($TEST_YEAR, $OPT_OUT_YEAR);" >/dev/null 2>&1
  echo "  cleanup: removed T91-${TS}-* assets + their AfA expenses + auto-booked audit log entries; restored settings"
}
trap cleanup EXIT

# ===== Seed assets =====
# Asset 1: 6000 EUR AK, 60 months ND → monthlyAfA
# = 100, annualAfA = 1200.
# Asset 2: 12000 EUR AK, 60 months ND → monthlyAfA
# = 200, annualAfA = 2400.
TMP_SQL=$(mktemp -t autoafa-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Asset" (id, "companyId", type, bezeichnung, "anschaffungsDatum", "anschaffungsKosten", "nutzungsdauerMonate", restwert, "afaMethode", "bilanzKonto", notiz, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'Maschine', 'T91-${TS}-Maschine-1', '2028-01-01', 6000, 60, 0, 'linear', '0300', NULL, now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'Maschine', 'T91-${TS}-Maschine-2', '2029-01-01', 12000, 60, 0, 'linear', '0300', NULL, now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"

ASSET1_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Asset\" WHERE \"companyId\"='$COMPANY_ID' AND bezeichnung='T91-${TS}-Maschine-1';" \
  2>&1 | tr -d ' ' | head -1)
ASSET2_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Asset\" WHERE \"companyId\"='$COMPANY_ID' AND bezeichnung='T91-${TS}-Maschine-2';" \
  2>&1 | tr -d ' ' | head -1)
echo "  created asset 1 $ASSET1_ID (year 2028, annualAfA=1200)"
echo "  created asset 2 $ASSET2_ID (year 2029, annualAfA=2400)"

# ===== 1. Test-only route responds =====
echo
echo "=== 1. POST /api/v1/assets/_test/auto-booker-trigger responds ==="
RESP=$(curl -sS -X POST \
  "$API/api/v1/assets/_test/auto-booker-trigger?year=$TEST_YEAR" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
echo "  response: $RESP" | head -c 200
echo "..."
# The response should have companies + bookedCount fields.
HAS_COMPANIES=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'companies' in d else 'no')")
HAS_BOOKED=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'bookedCount' in d else 'no')")
assert_eq "response has 'companies'" "$HAS_COMPANIES" "yes"
assert_eq "response has 'bookedCount'" "$HAS_BOOKED" "yes"
COMPANIES_COUNT=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['companies'])")
echo "  companies in DB: $COMPANIES_COUNT"

# ===== 2. force-trigger created 12 monthly rows for asset 1 =====
echo
echo "=== 2. force-trigger booked 12 monthly AfA rows for asset 1 ==="
BOOKED_COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET1_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows for asset 1" "$BOOKED_COUNT" "12"
# Verify each row has afaMonth 1-12.
MONTHS_PRESENT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(DISTINCT \"afaMonth\") FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET1_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "distinct afaMonth values" "$MONTHS_PRESENT" "12"
# Verify the sum = annualAfA = 1200.
BOOKED_SUM=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT ROUND(SUM(ABS(\"grossAmount\"::numeric)), 2) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET1_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA sum = annualAfA 1200" "$BOOKED_SUM" "1200.00"
# Verify Dec absorbs the rounding remainder (for 100/12 the last month differs from the others).
DEC_AMOUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT ROUND(ABS(\"grossAmount\"::numeric), 2) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET1_ID' AND \"category\"='AfA' AND \"afaMonth\"=12;" \
  2>&1 | tr -d ' ')
# 6000/60/12 = 100/12 = 8.33. So months 1-11 = 8.33, month 12 = 100 - 11*8.33 = 8.37.
# Actually wait: monthlyAfA = (AK - Restwert) / ND = 6000/60 = 100, annualAfA
# = 12*100 = 1200 (full year). The split is 1200/12 = 100 each, exact. So
# Dec = 100.00.
assert_eq "Dec AfA amount" "$DEC_AMOUNT" "100.00"
# Verify bookingMode via booking-status.
STATUS_MODE=$(curl -sS \
  "$API/api/v1/assets/booking-status?companyId=$COMPANY_ID&year=$TEST_YEAR" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
  if r['assetId']=='$ASSET1_ID':
    print(r['bookingMode'])
    break
")
assert_eq "bookingMode = monthly" "$STATUS_MODE" "monthly"

# ===== 3. Idempotency: re-run is a no-op =====
echo
echo "=== 3. re-run force-trigger is idempotent ==="
RESP2=$(curl -sS -X POST \
  "$API/api/v1/assets/_test/auto-booker-trigger?year=$TEST_YEAR" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
SECOND_BOOKED=$(echo "$RESP2" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['bookedCount'])")
# The first call booked 12 rows for asset 1 + maybe
# some for other companies' assets. The second call
# should book 0 new rows for our test asset.
SECOND_BOOKED_ASSET1=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET1_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows for asset 1 after re-run (still 12)" "$SECOND_BOOKED_ASSET1" "12"
echo "  re-run bookedCount=$SECOND_BOOKED (expected 0 for our test assets; other companies' already-booked assets are also 0)"

# ===== 4. Per-company opt-out via settings.autoBookAfa=false =====
echo
echo "=== 4. opt-out: settings.autoBookAfa=false skips SH Leder ==="
# Set autoBookAfa=false on SH Leder only.
UPDATED_SETTINGS=$(echo "$ORIGINAL_SETTINGS" | python3 -c "
import json,sys
s = json.loads(sys.stdin.read())
s['autoBookAfa'] = False
print(json.dumps(s))
")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings='$UPDATED_SETTINGS'::jsonb WHERE id='$COMPANY_ID';" >/dev/null
# Verify the settings were applied.
SETTINGS_AFABOOK=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT settings->>'autoBookAfa' FROM \"Company\" WHERE id='$COMPANY_ID';" \
  2>&1 | tr -d ' ')
assert_eq "settings.autoBookAfa = false" "$SETTINGS_AFABOOK" "false"
# Force trigger for OPT_OUT_YEAR. SH Leder should be skipped → no rows for asset 2.
RESP3=$(curl -sS -X POST \
  "$API/api/v1/assets/_test/auto-booker-trigger?year=$OPT_OUT_YEAR" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BOOKED_ASSET2_AFTER_OPT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET2_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows for asset 2 after opt-out trigger (expected 0)" "$BOOKED_ASSET2_AFTER_OPT" "0"

# ===== 5. Re-enable + re-trigger → asset 2 gets booked =====
echo
echo "=== 5. re-enable + re-trigger → asset 2 gets booked ==="
# Restore settings.autoBookAfa to true (we re-set
# it to the original value, but the original was
# missing → undefined, which is treated as enabled.
# So we explicitly set it to true for clarity).
RESTORED_SETTINGS=$(echo "$ORIGINAL_SETTINGS" | python3 -c "
import json,sys
s = json.loads(sys.stdin.read())
if 'autoBookAfa' in s:
  del s['autoBookAfa']
print(json.dumps(s))
")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings='$RESTORED_SETTINGS'::jsonb WHERE id='$COMPANY_ID';" >/dev/null
RESP4=$(curl -sS -X POST \
  "$API/api/v1/assets/_test/auto-booker-trigger?year=$OPT_OUT_YEAR" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BOOKED_ASSET2_AFTER_RE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"relatedAssetId\"='$ASSET2_ID' AND \"category\"='AfA';" \
  2>&1 | tr -d ' ')
assert_eq "AfA rows for asset 2 after re-enable (expected 12)" "$BOOKED_ASSET2_AFTER_RE" "12"

# ===== 6. Audit log entry 'assets.afa.auto_booked' =====
echo
echo "=== 6. Audit log 'assets.afa.auto_booked' for test year ==="
# We expect at least one auto_booked entry for
# TEST_YEAR with companyId=SH Leder and bookedCount
# >= 12. There may be multiple entries (one per
# force-trigger call) — we want the one with
# bookedCount > 0 (the first call booked 12 rows,
# the second call (idempotency test) booked 0).
AUDIT_YEAR=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT
    COALESCE(\"oldData\"->>'year', 'NULL') || '|' ||
    COALESCE(\"oldData\"->>'mode', 'NULL') || '|' ||
    COALESCE(\"oldData\"->>'triggeredBy', 'NULL') || '|' ||
    COALESCE(\"oldData\"->>'bookedCount', 'NULL')
  FROM \"AuditLog\"
  WHERE action='assets.afa.auto_booked'
    AND \"companyId\"='$COMPANY_ID'
    AND (\"oldData\"->>'year')::int = $TEST_YEAR
    AND (\"oldData\"->>'bookedCount')::int > 0
  ORDER BY \"createdAt\" ASC LIMIT 1;" 2>&1 | tr -d ' ' | head -1)
AY_YEAR=$(echo "$AUDIT_YEAR" | cut -d'|' -f1)
AY_MODE=$(echo "$AUDIT_YEAR" | cut -d'|' -f2)
AY_TRIG=$(echo "$AUDIT_YEAR" | cut -d'|' -f3)
AY_BC=$(echo "$AUDIT_YEAR" | cut -d'|' -f4)
assert_eq "audit oldData.year" "$AY_YEAR" "$TEST_YEAR"
assert_eq "audit oldData.mode" "$AY_MODE" "monthly"
assert_eq "audit oldData.triggeredBy" "$AY_TRIG" "AfaAutoBookerScheduler:force"
# bookedCount should be > 0 (at least 12 for our asset).
# Actually the bookedCount in the audit entry is for
# THIS company only (the auto-booker iterates companies
# and writes a per-company audit entry). So the entry
# for SH Leder's TEST_YEAR should show bookedCount >= 12.
if [ "$AY_BC" -lt 12 ]; then
  echo "  FAIL: audit oldData.bookedCount=$AY_BC (expected >= 12)"
  exit 1
else
  echo "  PASS: audit oldData.bookedCount=$AY_BC (>= 12)"
fi

# ===== 7. Cron schedule string is "5 0 1 * *" =====
echo
echo "=== 7. Cron schedule string in scheduler source ==="
SCHEDULER_FILE="$SCRIPT_DIR/../src/modules/assets/afa-auto-booker.scheduler.ts"
if [ ! -f "$SCHEDULER_FILE" ]; then
  echo "  FAIL: scheduler file not found at $SCHEDULER_FILE"
  exit 1
fi
CRON_LINE=$(grep -E '@Cron\(' "$SCHEDULER_FILE" | head -1)
echo "  cron decorator: $CRON_LINE"
# Defense against accidental schedule change.
if ! echo "$CRON_LINE" | grep -q '"5 0 1 \* \*"'; then
  echo "  FAIL: cron schedule is not '5 0 1 * *' (got: $CRON_LINE)"
  exit 1
fi
echo "  PASS: cron schedule is '5 0 1 * *' (5 0 1 * * in Berlin time)"
# Also check the timezone.
if ! echo "$CRON_LINE" | grep -q 'Europe/Berlin'; then
  echo "  FAIL: cron timezone is not Europe/Berlin"
  exit 1
fi
echo "  PASS: cron timezone is Europe/Berlin"

echo
summary
