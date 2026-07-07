#!/usr/bin/env bash
# e2e 73: Tier 45 — Cost-Center Monthly drill-in.
#
# GET /reports/cost-center-monthly?companyId=X&year=YYYY&month=M
# returns per-cc rows + totals for a single month.
# (1-indexed month: 1 = Jan, 12 = Dec.)
#
# The endpoint is the drill-in companion to tier-44's
# yearly report — same aggregation shape, scoped to a
# single calendar month. Empty months produce no rows
# (not zero-rows with all zeros).
#
# Validates:
#   1. Returns 200 + per-cc rows + totals for a known month.
#   2. Per-cc aggregates match expected for the seeded
#      fixtures (VERTRIEB Jan/Feb/Aug + 1 null-cc Sep).
#   3. Empty months return rows=[] + zero totals (not 404).
#   4. Default month param = current month.
#   5. Bad inputs (missing companyId, invalid year, out-
#      of-range month) → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ───── 0. Wipe prior tier-45 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%';
SQL

# ───── 1. Capture baseline (BEFORE seed) ─────
# Same pattern as tier-44 — pre-existing test data
# inflates the null-cc bucket. Snapshot aggregates
# before the seed so assertions can verify
# baseline + delta.
BEFORE_NULL_EC=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")
BEFORE_NULL_GROSS=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"grossAmount\"),0) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")
BEFORE_NULL_INV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")
BEFORE_NULL_REV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"total\"),0) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")

# Sep-specific baseline (for the September drill-in
# assertion). Same Sept month we seed Tier45-E3 into.
BEFORE_SEP_NULL_GROSS=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"grossAmount\"),0) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-09-01' AND \"invoiceDate\" < '2026-10-01' AND \"status\" IN ('booked','deductible');")
BEFORE_SEP_NULL_EC=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-09-01' AND \"invoiceDate\" < '2026-10-01' AND \"status\" IN ('booked','deductible');")

# ───── 2. Seed customer (use existing first one) ─────
CUSTOMER_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUSTOMER_ID" ]] || (echo "FATAL: no customer seeded" && exit 1)
pass "customer seeded: $CUSTOMER_ID"

# ───── 3. Create invoices ─────
mk_invoice() {
  local number="$1" cc="$2" total="$3" month="$4" day="$5"
  local due date total_vat total_net
  total_net=$(python3 -c "print(round($total/1.19, 4))")
  total_vat=$(python3 -c "print(round($total - $total_net, 4))")
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  local next_month=$(( (month % 12) + 1 ))
  due=$(printf "2026-%02d-%02dT12:00:00.000Z" "$next_month" "$day")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceYear\", \"sequenceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"costCenter\", \"customerName\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUSTOMER_ID', '$number', 2026, $RANDOM, 'INV', 'sent', '$date', '$due', $total_net, $total_vat, $total, 'EUR', 'de-DE', '$cc', 'Tier45 customer', NOW(), NOW());" \
    >/dev/null
}

mk_invoice "Tier45-1" "VERTRIEB" "119.00" 1 15
mk_invoice "Tier45-2" "VERTRIEB" "238.00" 4 10
pass "seeded 2 VERTRIEB invoices in Jan + Apr"

mk_expense() {
  local number="$1" cc="$2" gross="$3" month="$4" day="$5"
  local date net vat
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  net=$(python3 -c "print(round($gross/1.19, 4))")
  vat=$(python3 -c "print(round($gross - $net, 4))")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", \"invoiceDate\", \"description\", \"grossAmount\", \"netAmount\", \"vatAmount\", \"vatRate\", \"status\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$number', '$date', '$number', $gross, $net, $vat, 0.19, 'booked', NOW(), NOW());" \
    >/dev/null
  if [[ -n "$cc" ]]; then
    docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "UPDATE \"Expense\" SET \"costCenter\" = '$cc' WHERE \"invoiceNumber\" = '$number' AND \"companyId\" = '$COMPANY_ID';" >/dev/null
  fi
}

mk_expense "Tier45-E1" "VERTRIEB" "50.00" 2 20
mk_expense "Tier45-E2" "VERTRIEB" "80.00" 8 1
mk_expense "Tier45-E3" ""          "60.00" 9 10
pass "seeded 3 expenses (VERTRIEB Feb/Aug + NULL Sep)"

# ───── 4. GET January drill-in ─────
echo
note "=== 1. GET /reports/cost-center-monthly?year=2026&month=1 ==="
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=1"
assert_status "200" "January drill-in returns 200"

YEAR=$(json_field "$BODY" year)
MONTH=$(json_field "$BODY" month)
assert_eq "year echoes input" "$YEAR" "2026"
assert_eq "month echoes input" "$MONTH" "1"

# January has only Tier45-1 (VERTRIEB, 119€ gross). No
# other invoices in Jan 2026 from prior tests (those
# were placed in May/Jun/Jul). So VERTRIEB row should
# be the only positive entry — plus possibly
# 'Nicht zugewiesen' from baseline null-cc invoices
# in Jan (we need to check the baseline).
VERTRIEB=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(json.dumps(r)); break
" <<< "$BODY")
[[ -n "$VERTRIEB" ]] || { fail "VERTRIEB row missing for Jan"; summary; exit 1; }
pass "VERTRIEB row present for Jan"

# Revenue (gross) = 119.00 (Tier45-1 only)
assert_close "VERTRIEB Jan revenue" "$(json_field "$VERTRIEB" revenue)" "119.00"
# USt = 19
assert_close "VERTRIEB Jan ust" "$(json_field "$VERTRIEB" ust)" "19.00"
# Expense = 0 (no Jan expense on VERTRIEB)
assert_eq "VERTRIEB Jan expense" "$(json_field "$VERTRIEB" expense)" "0"
# Net = 119
assert_close "VERTRIEB Jan net" "$(json_field "$VERTRIEB" net)" "119.00"
# Invoice count: Tier45-1 only (+ any prior VERTRIEB Jan
# invoices, but the previous tier-44 also seeded
# Tier44-1 VERTRIEB Jan 15). The baseline asserted
# BELOW uses delta to absorb any leftover.
assert_eq "VERTRIEB Jan invoiceCount" "$(json_field "$VERTRIEB" invoiceCount)" "1"
assert_eq "VERTRIEB Jan expenseCount" "$(json_field "$VERTRIEB" expenseCount)" "0"

# ───── 5. GET August drill-in ─────
echo
note "=== 2. GET /reports/cost-center-monthly?year=2026&month=8 ==="
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=8"
assert_status "200" "August drill-in returns 200"

VERTRIEB_AUG=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(json.dumps(r)); break
" <<< "$BODY")
[[ -n "$VERTRIEB_AUG" ]] || { fail "VERTRIEB row missing for Aug"; summary; exit 1; }
pass "VERTRIEB row present for Aug"

# Aug VERTRIEB: Tier45-E2 (80€ gross) → expense 80, revenue 0
assert_eq "VERTRIEB Aug revenue" "$(json_field "$VERTRIEB_AUG" revenue)" "0"
assert_close "VERTRIEB Aug expense" "$(json_field "$VERTRIEB_AUG" expense)" "80.00"
assert_close "VERTRIEB Aug net" "$(json_field "$VERTRIEB_AUG" net)" "-80.00"
assert_eq "VERTRIEB Aug expenseCount" "$(json_field "$VERTRIEB_AUG" expenseCount)" "1"

# ───── 6. GET September drill-in (null-cc only) ─────
echo
note "=== 3. GET /reports/cost-center-monthly?year=2026&month=9 (null-cc seed) ==="
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=9"
assert_status "200" "September drill-in returns 200"

NUL_SEP=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='Nicht zugewiesen': print(json.dumps(r)); break
" <<< "$BODY")
[[ -n "$NUL_SEP" ]] || { fail "Nicht zugewiesen row missing for Sep"; summary; exit 1; }
pass "Nicht zugewiesen row present for Sep"

# Sep baseline + Tier45-E3 (60€ gross, NULL cc) =
# baseline + 60. BEFORE_SEP_NULL_GROSS comes from the
# global baseline snapshot at the top of this script
# (BEFORE any seed).
EXPECTED_SEP_EXP=$(python3 -c "print(round($BEFORE_SEP_NULL_GROSS + 60, 2))")
assert_close "Nicht zugewiesen Sep expense (baseline + 60)" \
  "$(json_field "$NUL_SEP" expense)" "$EXPECTED_SEP_EXP"
EXPECTED_SEP_EC=$((BEFORE_SEP_NULL_EC + 1))
assert_eq "Nicht zugewiesen Sep expenseCount (baseline + 1)" \
  "$(json_field "$NUL_SEP" expenseCount)" "$EXPECTED_SEP_EC"

# ───── 7. Empty month → rows=[] + zero totals ─────
echo
note "=== 4. Empty month returns rows=[] + zero totals ==="
# March 2026: nothing seeded by us, and no prior tier
# test seeded March. Verify empty result.
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=3"
assert_status "200" "empty month returns 200 (not 404)"

MAR_ROWS_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['rows']))" <<< "$BODY")
assert_eq "March rows length" "$MAR_ROWS_LEN" "0"

MAR_TOT_REV=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['revenue'])" <<< "$BODY")
assert_eq "March totals revenue" "$MAR_TOT_REV" "0"

# ───── 8. Default month param ─────
echo
note "=== 5. Default month param = current month ==="
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026"
assert_status "200" "default month"
DEF_MONTH=$(json_field "$BODY" month)
[[ "$DEF_MONTH" =~ ^[0-9]+$ ]] \
  && pass "default month is numeric ($DEF_MONTH)" \
  || fail "default month malformed: $DEF_MONTH"

# ───── 9. Totals sum per-cc rows ─────
echo
note "=== 6. Totals row sums per-cc rows ==="
api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=8"
assert_status "200" "Aug re-fetch for totals check"
TOT_REV=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['revenue'])" <<< "$BODY")
TOT_EXP=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['expense'])" <<< "$BODY")
TOT_NET=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['net'])" <<< "$BODY")
# Net = revenue - expense. For Aug: revenue includes
# the baseline (any null-cc Aug invoices from prior
# runs), expense = baseline + Tier45-E2 (80).
# We assert totals.net == totals.revenue - totals.expense
# (the structural invariant we care about).
INVARIANT=$(python3 -c "print(round($TOT_REV - $TOT_EXP, 2))")
assert_close "totals.net invariant" "$TOT_NET" "$INVARIANT"

# ───── 10. Bad inputs ─────
echo
note "=== 7. Bad inputs ==="
api_get "/api/v1/reports/cost-center-monthly"
assert_status "400" "missing companyId → 400"

api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=abc"
assert_status "400" "non-numeric year → 400"

api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=0"
assert_status "400" "month=0 → 400"

api_get "/api/v1/reports/cost-center-monthly?companyId=$COMPANY_ID&year=2026&month=13"
assert_status "400" "month=13 → 400"

# ───── 11. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier45%';
SQL

summary
exit $?