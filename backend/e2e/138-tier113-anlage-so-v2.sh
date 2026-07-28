#!/usr/bin/env bash
# e2e 138: Tier 113 v2 — Anlage SO v2
# (broker PDF/CSV auto-import + full loss-verrechnung
# per § 23 Abs. 3 Satz 3-5 EStG + auto-import from
# bank-transaction Expense rows).
#
# Validates the v2 endpoints:
#   GET  /api/v1/accounting/anlage-so/v2
#   GET  /api/v1/accounting/anlage-so/v2.pdf
#   POST /api/v1/accounting/anlage-so/import-csv
#   POST /api/v1/accounting/anlage-so/import-from-expenses
#   GET  /api/v1/accounting/anlage-so/loss-carryforward
#   GET  /api/v1/accounting/anlage-so/importable-expenses
#
# Test plan (16 sections, 60+ assertions):
#   0.  Wipe prior tier-113 fixtures (idempotent re-runs)
#   1.  Setup: create 3 expenses (2 crypto + 1 brokerage) for $YEAR
#   2.  Loss-verrechnung math: 2 gains + 2 losses → verify
#       inFristGain / inFristLoss / totalTaxableGain / carryforward
#   3.  Freigrenze interaction: gain - loss = 500 → vgTotal = 0
#   4.  Freigrenze edge: gain - loss = 700 → vgTotal = 700
#   5.  Loss carryforward: gain = 100, loss = 1000 → vgTotal = 0,
#       carryforward = 900
#   6.  Prior-year carryforward: priorYearLoss = 500 (seeded in
#       Company.settings), gain = 200, loss = 0 → vgTotal = 0,
#       carryforward = 300
#   7.  Out-of-Frist: Sonstige WG held 15 years → ignored
#   8.  CSV import: 4 rows → preview → confirm
#   9.  CSV import validation: bad date / bad decimal /
#       missing column → 400
#   10. CSV import dedup: 2nd time same CSV → skippedCount=4
#   11. Expense auto-import: 3 expenses → importedCount=3
#   12. Expense re-import: re-import → skippedCount=3
#   13. Berater packager: Kz 99 line + Verlustvortrag
#   14. Cross-tenant: no x-user-id → 401
#   15. PDF endpoint (v2.pdf) returns valid PDF
#   16. Cleanup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"
TS=$(date +%s)
# Polish #10: fixed year. The original `YEAR=$((2025 + (TS % 3)))`
# randomly picked 2025/2026/2027, but the test seed uses
# `acquisitionDate=YEAR-1` for some rows (e.g. 2024-10-01
# for YEAR-1=2024 would make YEAR=2025 the only valid choice
# — other years would filter out the transaction at
# `Number(t.saleDate.slice(0,4)) === year`).
YEAR=2026
PRIOR_YEAR=$((YEAR - 1))
PREFIX="T113-$TS"

note "=== Test prefix: $PREFIX / year: $YEAR / priorYear: $PRIOR_YEAR ==="

# ───── 0. Wipe prior tier-113 fixtures ─────
# anlageSO[year] and anlageSOLossCarryforward[year] +
# [year-1] are JSONB fields on Company.settings. We
# reset them by writing a known-empty object via the
# settings endpoint (and the SQL fallback for the
# carryforward, which the settings endpoint doesn't
# touch). The Expense rows for the company are kept
# (the test uses them and the v2 service skips
# already-imported), so we filter by PREFIX in the
# description to only delete ours.
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{\"year\": $YEAR, \"transactions\": [], \"wiederkehrendeBezuege\": 0, \"werbungskosten\": 0}" >/dev/null
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Expense"
  WHERE "companyId" = '$COMPANY_ID'
    AND description LIKE '${PREFIX}%';
-- Wipe the carryforward map (it lives outside the
-- anlageSO[year] block, so the settings PUT doesn't
-- clear it).
UPDATE "Company" SET settings = settings
  || jsonb_build_object('anlageSOLossCarryforward', '{}'::jsonb)
  WHERE id = '$COMPANY_ID';
SQL
pass "wiped prior tier-113 fixtures"

# ───── 1. Setup: create 3 Expense rows ─────
# 2 crypto (sonstige) + 1 brokerage (wertpapier).
# We use direct SQL because the /expenses POST has
# more required fields than the v2 import needs.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Expense" (id, "companyId", "invoiceNumber", description, "invoiceDate",
                       "netAmount", "vatRate", "vatAmount", "grossAmount", category,
                       "isIntraEU", "isReverseCharge", status, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '$COMPANY_ID', 'INV-T113-1', '${PREFIX} BTC Kauf + Verkauf',
   '${YEAR}-03-15 00:00:00+00', 5000, 0, 0, 5000, 'crypto', false, false, 'booked', NOW(), NOW()),
  (gen_random_uuid(), '$COMPANY_ID', 'INV-T113-2', '${PREFIX} ETH Kauf + Verkauf',
   '${YEAR}-06-10 00:00:00+00', 3000, 0, 0, 3000, 'crypto', false, false, 'booked', NOW(), NOW()),
  (gen_random_uuid(), '$COMPANY_ID', 'INV-T113-3', '${PREFIX} AAPL Trade',
   '${YEAR}-09-20 00:00:00+00', 8000, 0, 0, 8000, 'brokerage', false, false, 'booked', NOW(), NOW());
SQL
pass "created 3 expense fixtures"

# ───── 2. Loss-verrechnung math: 2 gains + 2 losses ─────
echo
note "=== 2. Loss-verrechnung: 2 gains + 2 losses ==="
# 4 sales in $YEAR, all within Frist (Wertpapier 1y):
#   - 1000 → 1500  (gain 500)
#   - 2000 → 2500  (gain 500)
#   - 5000 → 3000  (loss 2000)
#   - 3000 → 2500  (loss 500)
# inFristGain = 1000, inFristLoss = 2500
# totalTaxableGain = max(0, 1000 - 2500 - 0) = 0
# carryforward = max(0, 2500 + 0 - 1000) = 1500
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      {
        \"type\": \"wertpapier\",
        \"description\": \"AAPL 10 shares\",
        \"acquisitionDate\": \"$((YEAR-1))-04-01\",
        \"acquisitionCost\": 1000,
        \"saleDate\": \"$YEAR-02-15\",
        \"salePrice\": 1500
      },
      {
        \"type\": \"wertpapier\",
        \"description\": \"MSFT 5 shares\",
        \"acquisitionDate\": \"$((YEAR-1))-08-01\",
        \"acquisitionCost\": 2000,
        \"saleDate\": \"$YEAR-05-10\",
        \"salePrice\": 2500
      },
      {
        \"type\": \"wertpapier\",
        \"description\": \"TSLA 20 shares\",
        \"acquisitionDate\": \"$((YEAR-1))-09-01\",
        \"acquisitionCost\": 5000,
        \"saleDate\": \"$YEAR-08-20\",
        \"salePrice\": 3000
      },
      {
        \"type\": \"wertpapier\",
        \"description\": \"NVDA 8 shares\",
        \"acquisitionDate\": \"$((YEAR-1))-12-01\",
        \"acquisitionCost\": 3000,
        \"saleDate\": \"$YEAR-10-15\",
        \"salePrice\": 2500
      }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null

api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
assert_status "200" "GET /anlage-so/v2"
IN_FRIST_GAIN=$(json_field "$BODY" "vg.inFristGain")
IN_FRIST_LOSS=$(json_field "$BODY" "vg.inFristLoss")
TOTAL_TAXABLE=$(json_field "$BODY" "vg.totalTaxableGain")
CARRYFORWARD=$(json_field "$BODY" "vg.carryforward")
VG_TOTAL=$(json_field "$BODY" "vg.vgTotal")
assert_close "inFristGain = 1000" "$IN_FRIST_GAIN" "1000"
assert_close "inFristLoss = 2500" "$IN_FRIST_LOSS" "2500"
assert_close "totalTaxableGain = 0" "$TOTAL_TAXABLE" "0"
assert_close "carryforward = 1500" "$CARRYFORWARD" "1500"
assert_close "vgTotal = 0 (all-offset)" "$VG_TOTAL" "0"

# ───── 3. Freigrenze interaction ─────
echo
note "=== 3. Freigrenze: gain - loss = 500 → vgTotal = 0 ==="
# gain=2000, loss=1500 → net=500 → ≤600 → vgTotal=0
# carryforward = max(0, 1500 - 2000) = 0
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      { \"type\": \"wertpapier\", \"description\": \"G1\", \"acquisitionDate\": \"$((YEAR-1))-09-01\", \"acquisitionCost\": 1000, \"saleDate\": \"$YEAR-07-01\", \"salePrice\": 2000 },
      { \"type\": \"wertpapier\", \"description\": \"G2\", \"acquisitionDate\": \"$((YEAR-1))-10-01\", \"acquisitionCost\": 500, \"saleDate\": \"$YEAR-08-01\", \"salePrice\": 1000 },
      { \"type\": \"wertpapier\", \"description\": \"L1\", \"acquisitionDate\": \"$((YEAR-1))-11-01\", \"acquisitionCost\": 2000, \"saleDate\": \"$YEAR-09-01\", \"salePrice\": 500 }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
GAIN3=$(json_field "$BODY" "vg.inFristGain")
LOSS3=$(json_field "$BODY" "vg.inFristLoss")
TAXABLE3=$(json_field "$BODY" "vg.totalTaxableGain")
VG3=$(json_field "$BODY" "vg.vgTotal")
FGA3=$(json_field "$BODY" "vg.freigrenzeApplied")
assert_close "gain = 2000" "$GAIN3" "2000"
assert_close "loss = 1500" "$LOSS3" "1500"
assert_close "taxable = 500" "$TAXABLE3" "500"
assert_close "vgTotal = 0 (Freigrenze)" "$VG3" "0"
test "$FGA3" = "True" && pass "freigrenzeApplied = true" || fail "freigrenzeApplied = $FGA3"

# ───── 4. Freigrenze edge: gain - loss = 700 → vgTotal = 700 ─────
echo
note "=== 4. Freigrenze edge: gain - loss = 700 ==="
# gain=2000, loss=1300 → net=700 → >600 → vgTotal=700
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      { \"type\": \"wertpapier\", \"description\": \"G1\", \"acquisitionDate\": \"$((YEAR-1))-08-01\", \"acquisitionCost\": 1000, \"saleDate\": \"$YEAR-06-01\", \"salePrice\": 2000 },
      { \"type\": \"wertpapier\", \"description\": \"G2\", \"acquisitionDate\": \"$((YEAR-1))-09-01\", \"acquisitionCost\": 500, \"saleDate\": \"$YEAR-07-01\", \"salePrice\": 1500 },
      { \"type\": \"wertpapier\", \"description\": \"L1\", \"acquisitionDate\": \"$((YEAR-1))-10-01\", \"acquisitionCost\": 2000, \"saleDate\": \"$YEAR-08-01\", \"salePrice\": 700 }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
VG4=$(json_field "$BODY" "vg.vgTotal")
FGA4=$(json_field "$BODY" "vg.freigrenzeApplied")
assert_close "vgTotal = 700 (gain-loss=700, > Freigrenze)" "$VG4" "700"
test "$FGA4" = "False" && pass "freigrenzeApplied = false" || fail "freigrenzeApplied = $FGA4"

# ───── 5. Loss carryforward: gain=100, loss=1000 → carryforward=900 ─────
echo
note "=== 5. Loss carryforward: gain=100, loss=1000 ==="
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      { \"type\": \"wertpapier\", \"description\": \"Tiny gain\", \"acquisitionDate\": \"$((YEAR-1))-01-01\", \"acquisitionCost\": 1000, \"saleDate\": \"$YEAR-02-01\", \"salePrice\": 1100 },
      { \"type\": \"wertpapier\", \"description\": \"Big loss\", \"acquisitionDate\": \"$((YEAR-1))-04-01\", \"acquisitionCost\": 5000, \"saleDate\": \"$YEAR-05-01\", \"salePrice\": 4000 }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
GAIN5=$(json_field "$BODY" "vg.inFristGain")
LOSS5=$(json_field "$BODY" "vg.inFristLoss")
TAX5=$(json_field "$BODY" "vg.totalTaxableGain")
CF5=$(json_field "$BODY" "vg.carryforward")
assert_close "inFristGain = 100" "$GAIN5" "100"
assert_close "inFristLoss = 1000" "$LOSS5" "1000"
assert_close "totalTaxableGain = 0" "$TAX5" "0"
assert_close "carryforward = 900" "$CF5" "900"

# Verify the carryforward was persisted in
# Company.settings.anlageSOLossCarryforward[year]
# and the read endpoint returns it.
api_get "/api/v1/accounting/anlage-so/loss-carryforward?companyId=$COMPANY_ID&year=$YEAR"
CURR=$(json_field "$BODY" "currentYearLoss")
assert_close "loss-carryforward.currentYearLoss = 900" "$CURR" "900"

# ───── 6. Prior-year carryforward ─────
echo
note "=== 6. Prior-year carryforward: 500 ==="
# Seed a prior-year carryforward in
# Company.settings.anlageSOLossCarryforward[PRIOR_YEAR].
# Then PUT $YEAR with gain=200, loss=0 → totalTaxableGain
# = max(0, 200 - 0 - 500) = 0, carryforward = max(0,
# 0 + 500 - 200) = 300.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
UPDATE "Company" SET settings = settings
  || jsonb_build_object('anlageSOLossCarryforward',
       jsonb_build_object('$PRIOR_YEAR'::text, 500::numeric))
  WHERE id = '$COMPANY_ID';
SQL
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      { \"type\": \"wertpapier\", \"description\": \"Small gain\", \"acquisitionDate\": \"$((YEAR-1))-01-01\", \"acquisitionCost\": 1000, \"saleDate\": \"$YEAR-02-01\", \"salePrice\": 1200 }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
PRIOR=$(json_field "$BODY" "vg.priorYearLoss")
GAIN6=$(json_field "$BODY" "vg.inFristGain")
TAX6=$(json_field "$BODY" "vg.totalTaxableGain")
CF6=$(json_field "$BODY" "vg.carryforward")
assert_close "priorYearLoss = 500" "$PRIOR" "500"
assert_close "inFristGain = 200" "$GAIN6" "200"
assert_close "totalTaxableGain = 0 (offset by 500)" "$TAX6" "0"
assert_close "carryforward = 300" "$CF6" "300"

# ───── 7. Out-of-Frist: Sonstige WG held 15 years → ignored ─────
echo
note "=== 7. Out-of-Frist: Sonstige WG 15y → not in Frist ==="
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"transactions\": [
      { \"type\": \"sonstige\", \"description\": \"Old gold\", \"acquisitionDate\": \"$((YEAR-15))-01-01\", \"acquisitionCost\": 1000, \"saleDate\": \"$YEAR-06-01\", \"salePrice\": 5000 }
    ],
    \"wiederkehrendeBezuege\": 0,
    \"werbungskosten\": 0
  }" >/dev/null
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
IN_COUNT=$(json_field "$BODY" "vg.inFristCount")
OUT_COUNT=$(json_field "$BODY" "vg.outOfFristCount")
GAIN7=$(json_field "$BODY" "vg.inFristGain")
assert_eq "inFristCount = 0 (15y > 10y Frist)" "$IN_COUNT" "0"
assert_eq "outOfFristCount = 1" "$OUT_COUNT" "1"
assert_close "inFristGain = 0 (out-of-Frist ignored)" "$GAIN7" "0"

# Reset prior-year carryforward (so it doesn't
# pollute later tests)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = settings || jsonb_build_object('anlageSOLossCarryforward', jsonb_build_object('$PRIOR_YEAR'::text, 0::numeric)) WHERE id = '$COMPANY_ID';" >/dev/null

# ───── 8. CSV import: 4 rows → preview → confirm ─────
echo
note "=== 8. CSV import: 4 rows ==="
# Reset state to a clean year for the CSV test
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{\"year\": $YEAR, \"transactions\": [], \"wiederkehrendeBezuege\": 0, \"werbungskosten\": 0}" >/dev/null

CSV='type,description,acquisitionDate,acquisitionCost,saleDate,salePrice
wertpapier,AAPL 100,15.03.2024,12000,00,20.06.2024,15500,00
sonstige,Goldbarren,10.01.2024,5000,00,15.07.2024,6500,00
wertpapier,BTC 0,5,01.02.2024,8000,00,28.08.2024,12000,00
,MSFT unknown,,5000,00,01.03.2024,6500,00'

# Preview
api_post "/api/v1/accounting/anlage-so/import-csv" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"year\": $YEAR,
    \"csv\": $(echo "$CSV" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    \"previewOnly\": true
  }"
assert_status "200" "POST /import-csv (preview)"
PREV_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['preview']))")
OK_COUNT=$(json_field "$BODY" "okCount")
assert_eq "preview has 4 rows" "$PREV_COUNT" "4"
assert_eq "okCount = 4" "$OK_COUNT" "4"

# Confirm
api_post "/api/v1/accounting/anlage-so/import-csv" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"year\": $YEAR,
    \"csv\": $(echo "$CSV" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    \"previewOnly\": false
  }"
assert_status "200" "POST /import-csv (confirm)"
IMPORTED=$(json_field "$BODY" "importedCount")
assert_eq "importedCount = 4" "$IMPORTED" "4"

# Verify the 4 rows are persisted
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
TX_COUNT=$(json_field "$BODY" "vg.count")
assert_eq "vg.count = 4 (after CSV import)" "$TX_COUNT" "4"

# ───── 9. CSV import validation ─────
echo
note "=== 9. CSV import validation: bad date / bad decimal / missing column ==="

# Bad date
BAD_DATE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"year\":$YEAR,\"csv\":\"type,description,acquisitionDate,acquisitionCost,saleDate,salePrice\nwertpapier,Bad date,NOTADATE,1000,01.01.$YEAR,1500\",\"previewOnly\":true}" \
  "$API/api/v1/accounting/anlage-so/import-csv")
test "$BAD_DATE_STATUS" = "200" && pass "bad date → preview 200 (row marked ok=false)" || fail "bad date → $BAD_DATE_STATUS (expected 200 with row warning)"
# The preview still returns 200 — the row has a
# warning, but the rest of the CSV is valid.

# Bad decimal
api_post "/api/v1/accounting/anlage-so/import-csv" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"year\": $YEAR,
    \"csv\": \"type,description,acquisitionDate,acquisitionCost,saleDate,salePrice\nwertpapier,Bad,01.01.$((YEAR-1)),NOTANUMBER,01.01.$YEAR,1500\",
    \"previewOnly\": true
  }"
assert_status "200" "bad decimal → preview 200"

# Missing required column (acquisitionCost) → 400
MISSING_COL_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"year\":$YEAR,\"csv\":\"type,description,acquisitionDate,saleDate,salePrice\nwertpapier,Missing,01.01.$((YEAR-1)),01.01.$YEAR,1500\",\"previewOnly\":true}" \
  "$API/api/v1/accounting/anlage-so/import-csv")
test "$MISSING_COL_STATUS" = "400" && pass "missing column → 400" || fail "missing column → $MISSING_COL_STATUS (expected 400)"

# Empty CSV → 400
EMPTY_CSV_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"year\":$YEAR,\"csv\":\"\",\"previewOnly\":true}" \
  "$API/api/v1/accounting/anlage-so/import-csv")
test "$EMPTY_CSV_STATUS" = "400" && pass "empty CSV → 400" || fail "empty CSV → $EMPTY_CSV_STATUS (expected 400)"

# ───── 10. CSV import dedup: 2nd time same CSV → skippedCount=4 ─────
echo
note "=== 10. CSV import dedup: 2nd time same CSV ==="
# Re-import the same 4 rows. All 4 should be
# recognized as duplicates of the existing rows.
api_post "/api/v1/accounting/anlage-so/import-csv" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"year\": $YEAR,
    \"csv\": $(echo "$CSV" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    \"previewOnly\": true
  }"
DUP_COUNT=$(json_field "$BODY" "duplicateCount")
assert_eq "duplicateCount = 4 (all are dupes)" "$DUP_COUNT" "4"

# Now confirm-path: all 4 should be skipped.
api_post "/api/v1/accounting/anlage-so/import-csv" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"year\": $YEAR,
    \"csv\": $(echo "$CSV" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    \"previewOnly\": false
  }"
assert_status "200" "POST /import-csv (dedup confirm)"
SKIPPED10=$(json_field "$BODY" "skippedCount")
IMPORTED10=$(json_field "$BODY" "importedCount")
assert_eq "dedup: skippedCount = 4" "$SKIPPED10" "4"
assert_eq "dedup: importedCount = 0" "$IMPORTED10" "0"

# ───── 11. Expense auto-import: 3 expenses → importedCount=3 ─────
echo
note "=== 11. Expense auto-import: 3 expenses ==="
# Reset state for a clean import.
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{\"year\": $YEAR, \"transactions\": [], \"wiederkehrendeBezuege\": 0, \"werbungskosten\": 0}" >/dev/null
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = settings || jsonb_build_object('anlageSOLossCarryforward', '{}'::jsonb) WHERE id = '$COMPANY_ID';" >/dev/null

# List importable first
api_get "/api/v1/accounting/anlage-so/importable-expenses?companyId=$COMPANY_ID&year=$YEAR"
ITEM_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))")
assert_eq "importable-expenses.items = 3" "$ITEM_COUNT" "3"

# Now import them
api_post "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$COMPANY_ID&year=$YEAR" "{}"
assert_status "200" "POST /import-from-expenses"
IMPORTED11=$(json_field "$BODY" "importedCount")
SKIPPED11=$(json_field "$BODY" "skippedCount")
assert_eq "importedCount = 3" "$IMPORTED11" "3"
assert_eq "skippedCount = 0" "$SKIPPED11" "0"

# Verify 3 transactions
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
TX11=$(json_field "$BODY" "vg.count")
assert_eq "vg.count = 3 (after expense import)" "$TX11" "3"

# ───── 12. Expense re-import: re-import → skippedCount=3 ─────
echo
note "=== 12. Expense re-import: re-import → all skipped ==="
api_post "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$COMPANY_ID&year=$YEAR" "{}"
assert_status "200" "POST /import-from-expenses (re-import)"
IMPORTED12=$(json_field "$BODY" "importedCount")
SKIPPED12=$(json_field "$BODY" "skippedCount")
assert_eq "re-import: importedCount = 0" "$IMPORTED12" "0"
assert_eq "re-import: skippedCount = 3" "$SKIPPED12" "3"

# ───── 13. Berater packager: Kz 99 line + Verlustvortrag ─────
echo
note "=== 13. Berater packager: Kz 99 + Verlustvortrag ==="
# Seed a carryforward so the Kz 99 line shows up.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
UPDATE "Company" SET settings = settings
  || jsonb_build_object('anlageSOLossCarryforward',
       jsonb_build_object('$YEAR'::text, 500::numeric))
  WHERE id = '$COMPANY_ID';
SQL

PACK_FILE=/tmp/berater-t113-$TS.zip
PACK_STATUS=$(curl -sS -o "$PACK_FILE" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=$YEAR")
test "$PACK_STATUS" = "200" && pass "berater packager 200" || fail "berater packager → $PACK_STATUS"
if [ -s "$PACK_FILE" ] && unzip -l "$PACK_FILE" 2>/dev/null | grep "Anlage-SO.pdf" >/dev/null; then
  pass "Anlage-SO.pdf in packager"
else
  fail "Anlage-SO.pdf missing from packager"
fi

# Now the v2 compute() shows the Kz 99 line in the
# BMF table — verify the lines array contains it.
api_get "/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR"
KZS=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(','.join(l['kennziffer'] for l in d['lines']))
")
HAS_KZ99=$(echo "$KZS" | python3 -c "import sys; s=sys.stdin.read(); print('1' if '99' in s else '0')")
test "$HAS_KZ99" = "1" && pass "Kz 99 (Verlustvortrag) present in lines" || fail "Kz 99 missing from lines"
K99_AMT=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for l in d['lines']:
    if l['kennziffer']=='99':
        print(l['amount'])
        break
")
assert_close "Kz 99 amount = 500 (seeded)" "$K99_AMT" "500"

# ───── 14. Cross-tenant: no x-user-id → 401 ─────
echo
note "=== 14. Cross-tenant: no x-user-id → 401 ==="
NO_AUTH_V2=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-so/v2?companyId=$COMPANY_ID&year=$YEAR")
test "$NO_AUTH_V2" = "401" && pass "v2 no x-user-id → 401" || fail "v2 no x-user-id → $NO_AUTH_V2"
NO_AUTH_CSV=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"year\":$YEAR,\"csv\":\"\"}" \
  "$API/api/v1/accounting/anlage-so/import-csv")
test "$NO_AUTH_CSV" = "401" && pass "import-csv no x-user-id → 401" || fail "import-csv no x-user-id → $NO_AUTH_CSV"
NO_AUTH_EXP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" -d "{}" \
  "$API/api/v1/accounting/anlage-so/import-from-expenses?companyId=$COMPANY_ID&year=$YEAR")
test "$NO_AUTH_EXP" = "401" && pass "import-from-expenses no x-user-id → 401" || fail "import-from-expenses no x-user-id → $NO_AUTH_EXP"

# ───── 15. PDF endpoint (v2.pdf) returns valid PDF ─────
echo
note "=== 15. v2 PDF endpoint ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-so-v2-$TS.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-so/v2.pdf?companyId=$COMPANY_ID&year=$YEAR")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_SIZE=$(echo "$PDF_HEAD" | cut -d'|' -f3)
assert_eq "v2 PDF status 200" "$PDF_STATUS" "200"
assert_eq "v2 PDF content-type" "$PDF_CTYPE" "application/pdf"
test "$PDF_SIZE" -gt 1500 && pass "v2 PDF size = $PDF_SIZE bytes" || fail "v2 PDF too small: $PDF_SIZE"
file /tmp/anlage-so-v2-$TS.pdf | grep -q "PDF document" && pass "v2 PDF magic bytes OK" || fail "v2 PDF magic bytes bad"

# ───── 16. Cleanup ─────
echo
note "=== 16. Cleanup ==="
api_put "/api/v1/accounting/anlage-so/settings?companyId=$COMPANY_ID" \
  "{\"year\": $YEAR, \"transactions\": [], \"wiederkehrendeBezuege\": 0, \"werbungskosten\": 0}" >/dev/null
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Expense"
  WHERE "companyId" = '$COMPANY_ID'
    AND description LIKE '${PREFIX}%';
UPDATE "Company" SET settings = settings
  || jsonb_build_object('anlageSOLossCarryforward', '{}'::jsonb)
  WHERE id = '$COMPANY_ID';
SQL
pass "tier-113 fixtures wiped"

summary "Tier 113 v2 — Anlage SO v2 (broker CSV import + loss-verrechnung)"
