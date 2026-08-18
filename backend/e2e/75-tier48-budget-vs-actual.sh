#!/usr/bin/env bash
# e2e 75: Tier 48 — Cost-Center Budget vs Actual.
#
# Exercises the four new endpoints:
#   POST   /reports/cost-center-budgets        (upsert)
#   GET    /reports/cost-center-budgets        (list)
#   DELETE /reports/cost-center-budgets/:id    (delete)
#   GET    /reports/cost-center-budget-vs-actual (report)
#
# Plus the schema/migration applied via
#   prisma/migrations/20260707000001_cost_center_budget
#
# Validates:
#   1. POST creates a new budget, GET lists it.
#   2. POST same (cc, year) updates the existing row
#      (upsert, not duplicate).
#   3. POST with empty costCenter → "Nicht
#      zugewiesen" bucket row.
#   4. GET budget-vs-actual reports per-cc rows with
#      target[12], actual[12], delta[12], pct[12],
#      plus a totals row.
#   5. Bad inputs (missing companyId, invalid year,
#      monthlyTargets wrong length) → 400.
#   6. DELETE removes the budget; subsequent GET
#      budget-vs-actual shows target=0 for that cc.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# ───── 0. Wipe prior tier-48 fixtures + residue from other tests ─────
# Polish #10: also wipe residue VERTRIEB / MARKETING invoices
# + expenses from prior test runs (72, 73, 74 etc.). The
# budget-vs-actual report groups by costCenter, so any
# pre-existing VERTRIEB row would inflate the assertion.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%';
-- Wipe residue cost-center rows from prior tier tests
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "costCenter" IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')
  AND "issueDate" >= '2026-01-01' AND "issueDate" < '2027-01-01'
);
DELETE FROM "PaymentLink" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "costCenter" IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')
  AND "issueDate" >= '2026-01-01' AND "issueDate" < '2027-01-01'
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "costCenter" IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')
  AND "issueDate" >= '2026-01-01' AND "issueDate" < '2027-01-01'
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "costCenter" IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')
  AND "issueDate" >= '2026-01-01' AND "issueDate" < '2027-01-01';
DELETE FROM "Expense" WHERE "companyId" = '$COMPANY_ID'
  AND "costCenter" IN ('VERTRIEB', 'MARKETING', 'WERKSTATT')
  AND "invoiceDate" >= '2026-01-01' AND "invoiceDate" < '2027-01-01';
DELETE FROM "CostCenterBudget" WHERE "companyId" = '$COMPANY_ID';
SQL

# ───── 1. Seed customer ─────
CUSTOMER_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUSTOMER_ID" ]] || (echo "FATAL: no customer seeded" && exit 1)
pass "customer seeded: $CUSTOMER_ID"

# ───── 2. Seed minimal invoices/expenses for the
#         budget-vs-actual assertion ─────
mk_invoice() {
  local number="$1" cc="$2" total="$3" month="$4" day="$5"
  local total_vat total_net date due
  total_net=$(python3 -c "print(round($total/1.19, 4))")
  total_vat=$(python3 -c "print(round($total - $total_net, 4))")
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  local next_month=$(( (month % 12) + 1 ))
  due=$(printf "2026-%02d-%02dT12:00:00.000Z" "$next_month" "$day")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceYear\", \"sequenceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"costCenter\", \"customerName\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUSTOMER_ID', '$number', 2026, $RANDOM, 'INV', 'sent', '$date', '$due', $total_net, $total_vat, $total, 'EUR', 'de-DE', '$cc', 'Tier48 customer', NOW(), NOW());" \
    >/dev/null
}

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

# We seed deliberately clean: only Tier48 rows in 2026
# (we wiped baseline at the top of this script), so
# the budget-vs-actual numbers are deterministic.
mk_invoice "Tier48-1" "VERTRIEB" "119.00" 1 15
mk_expense "Tier48-E1" "VERTRIEB" "50.00" 1 20
pass "seeded 1 VERTRIEB invoice + 1 VERTRIEB expense in Jan 2026"

# ───── 3. POST budget for VERTRIEB ─────
echo
note "=== 1. POST /reports/cost-center-budgets (create) ==="
api_post "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID" \
  '{"year":2026,"costCenter":"VERTRIEB","label":"FY2026 plan","monthlyTargets":[200,200,200,200,200,200,200,200,200,200,200,200]}'
assert_status "201" "create VERTRIEB budget returns 201"

CC=$(json_field "$BODY" costCenter)
assert_eq "costCenter echoed" "$CC" "VERTRIEB"

LABEL=$(json_field "$BODY" label)
assert_eq "label echoed" "$LABEL" "FY2026 plan"

MT_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['monthlyTargets']))" <<< "$BODY")
assert_eq "monthlyTargets length" "$MT_LEN" "12"

# ───── 4. GET list shows the row ─────
echo
note "=== 2. GET /reports/cost-center-budgets ==="
api_get "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID&year=2026"
assert_status "200" "list budgets returns 200"
LIST_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['budgets']))" <<< "$BODY")
assert_eq "budgets length" "$LIST_LEN" "1"

# ───── 5. POST same triple updates (upsert) ─────
echo
note "=== 3. POST same (cc, year) updates existing (upsert) ==="
api_post "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID" \
  '{"year":2026,"costCenter":"VERTRIEB","label":"FY2026 plan v2","monthlyTargets":[300,300,300,300,300,300,300,300,300,300,300,300]}'
assert_status "201" "upsert returns 201"

NEW_LABEL=$(json_field "$BODY" label)
assert_eq "upsert updates label" "$NEW_LABEL" "FY2026 plan v2"

# The list still has 1 row (not 2).
api_get "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID&year=2026"
LIST_LEN_2=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['budgets']))" <<< "$BODY")
assert_eq "upsert keeps row count at 1" "$LIST_LEN_2" "1"

# ───── 6. POST empty costCenter → "Nicht zugewiesen" ─────
echo
note "=== 4. POST empty costCenter → Nicht zugewiesen bucket ==="
api_post "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID" \
  '{"year":2026,"costCenter":"","label":"Unassigned","monthlyTargets":[100,100,100,100,100,100,100,100,100,100,100,100]}'
assert_status "201" "empty-cc budget returns 201"
NULL_CC=$(json_field "$BODY" costCenter)
assert_eq "empty cc → Nicht zugewiesen" "$NULL_CC" "Nicht zugewiesen"

# ───── 7. GET budget-vs-actual ─────
echo
note "=== 5. GET /reports/cost-center-budget-vs-actual ==="
api_get "/api/v1/reports/cost-center-budget-vs-actual?companyId=$COMPANY_ID&year=2026"
assert_status "200" "bva report returns 200"

# Two rows: VERTRIEB + Nicht zugewiesen
ROWS_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['rows']))" <<< "$BODY")
assert_eq "bva rows length" "$ROWS_LEN" "2"

# VERTRIEB target = 300 (post-upsert), actual Jan = 119 - 50 = 69 (revenue minus expense)
VERTRIEB_BVA=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(json.dumps(r)); break
" <<< "$BODY")
[[ -n "$VERTRIEB_BVA" ]] || { fail "VERTRIEB row missing"; summary; exit 1; }
pass "VERTRIEB row present"

# target[0] = 300
TARGET_JAN=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['target'][0])" <<< "$VERTRIEB_BVA")
assert_eq "VERTRIEB Jan target" "$TARGET_JAN" "300"

# actual[0] = 69 (119 - 50)
ACTUAL_JAN=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['actual'][0])" <<< "$VERTRIEB_BVA")
assert_close "VERTRIEB Jan actual" "$ACTUAL_JAN" "69.00"

# delta[0] = 69 - 300 = -231 (under-budget for revenue target — actual < target)
DELTA_JAN=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['delta'][0])" <<< "$VERTRIEB_BVA")
assert_close "VERTRIEB Jan delta" "$DELTA_JAN" "-231.00"

# pct[0] = 69/300 ≈ 0.23
PCT_JAN=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['pct'][0])" <<< "$VERTRIEB_BVA")
assert_close "VERTRIEB Jan pct" "$PCT_JAN" "0.23"

# ───── 8. Bad inputs ─────
echo
note "=== 6. Bad inputs ==="
api_post "/api/v1/reports/cost-center-budgets" '{"year":2026,"monthlyTargets":[0,0,0,0,0,0,0,0,0,0,0,0]}'
assert_status "400" "missing companyId → 400"

api_post "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID" '{"year":2026,"monthlyTargets":[0,0,0,0,0,0,0,0,0,0]}'
assert_status "400" "monthlyTargets wrong length → 400"

api_get "/api/v1/reports/cost-center-budget-vs-actual?year=2026"
assert_status "400" "missing companyId on bva → 400"

# ───── 9. DELETE one budget + verify report reverts target ─────
echo
note "=== 7. DELETE removes the budget ==="
# Fetch the VERTRIEB budget id
api_get "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID&year=2026"
VERTRIEB_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for b in d['budgets']:
    if b['costCenter']=='VERTRIEB': print(b['id']); break
" <<< "$BODY")
[[ -n "$VERTRIEB_ID" ]] || { fail "VERTRIEB budget id missing"; summary; exit 1; }

api_delete "/api/v1/reports/cost-center-budgets/$VERTRIEB_ID?companyId=$COMPANY_ID"
assert_status "200" "delete VERTRIEB budget"

# List should now show 1 row (the NULL-cc one)
api_get "/api/v1/reports/cost-center-budgets?companyId=$COMPANY_ID&year=2026"
LIST_LEN_AFTER=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['budgets']))" <<< "$BODY")
assert_eq "list after delete" "$LIST_LEN_AFTER" "1"

# VERTRIEB bva row should now have target=0
api_get "/api/v1/reports/cost-center-budget-vs-actual?companyId=$COMPANY_ID&year=2026"
VERTRIEB_AFTER=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(json.dumps(r)); break
" <<< "$BODY")
TARGET_TOTAL_AFTER=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['targetTotal'])" <<< "$VERTRIEB_AFTER")
assert_eq "VERTRIEB targetTotal after delete" "$TARGET_TOTAL_AFTER" "0"

# ───── 10. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier48%';
DELETE FROM "CostCenterBudget" WHERE "companyId" = '$COMPANY_ID';
SQL

summary
exit $?