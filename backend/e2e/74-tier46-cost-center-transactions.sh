#!/usr/bin/env bash
# e2e 74: Tier 46 — Cost-Center Transactions drill-in.
#
# GET /reports/cost-center-transactions?companyId=X&year=YYYY
# &month=M&costCenter=CC returns the actual invoices +
# expenses that contribute to a single (year, month,
# cost-center) bucket. Same drill-in pattern as tier-45
# but one level deeper — "show me the rows that make
# up this month's 504€ net".
#
# Validates:
#   1. Returns 200 + transactions + totals + pagination
#      for a known (year, month, cc).
#   2. Transaction list is date-sorted ascending and
#      includes the seeded invoice/expense rows.
#   3. Totals.revenue/expense/ust/vorsteuer/counts
#      match the sum of returned transactions.
#   4. URL-decoded cc='Nicht zugewiesen' (or empty
#      cc param) matches the NULL-cc bucket.
#   5. take/skip pagination params work.
#   6. Bad inputs (missing companyId, invalid year/
#      month) → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ───── 0. Wipe prior tier-46 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%';
SQL

# ───── 1. Seed customer ─────
CUSTOMER_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUSTOMER_ID" ]] || (echo "FATAL: no customer seeded" && exit 1)
pass "customer seeded: $CUSTOMER_ID"

# ───── 2. Seed invoices ─────
mk_invoice() {
  local number="$1" cc="$2" total="$3" month="$4" day="$5"
  local due date total_vat total_net
  total_net=$(python3 -c "print(round($total/1.19, 4))")
  total_vat=$(python3 -c "print(round($total - $total_net, 4))")
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  local next_month=$(( (month % 12) + 1 ))
  due=$(printf "2026-%02d-%02dT12:00:00.000Z" "$next_month" "$day")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceYear\", \"sequenceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"costCenter\", \"customerName\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUSTOMER_ID', '$number', 2026, $RANDOM, 'INV', 'sent', '$date', '$due', $total_net, $total_vat, $total, 'EUR', 'de-DE', '$cc', 'Tier46 customer', NOW(), NOW());" \
    >/dev/null
}

mk_invoice "Tier46-1" "VERTRIEB" "119.00" 1 5
mk_invoice "Tier46-2" "VERTRIEB" "238.00" 1 18
mk_invoice "Tier46-3" "VERTRIEB" "357.00" 1 25
pass "seeded 3 VERTRIEB invoices in January"

# ───── 3. Seed expenses ─────
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

mk_expense "Tier46-E1" "VERTRIEB" "50.00" 1 10
mk_expense "Tier46-E2" "VERTRIEB" "80.00" 1 22
mk_expense "Tier46-E3" ""          "60.00" 1 28
pass "seeded 3 expenses (VERTRIEB × 2 + NULL × 1) in January"

# Compute expected vorsteuer with the same rounding
# the DB applies (Decimal(12,4)). gross / 1.19 = net
# (rounded to 4 decimals), vat = gross − net. For our
# seeds: 50.0000 − 42.0168 = 7.9832 and 80.0000 −
# 67.2269 = 12.7731 → total = 20.7563. We compare
# against the actual sum (not a fixed 20.80).
EXPECTED_VST=$(python3 -c "
e1_v = round(50.00 - round(50.00/1.19, 4), 4)
e2_v = round(80.00 - round(80.00/1.19, 4), 4)
print(round(e1_v + e2_v, 4))
")
echo "  expected vorsteuer = $EXPECTED_VST"

# ───── 4. GET transactions for VERTRIEB Jan ─────
echo
note "=== 1. GET /cost-center-transactions?year=2026&month=1&costCenter=VERTRIEB ==="
api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=1&costCenter=VERTRIEB"
assert_status "200" "transactions drill-in returns 200"

YEAR=$(json_field "$BODY" year)
MONTH=$(json_field "$BODY" month)
CC=$(json_field "$BODY" costCenter)
assert_eq "year echoes input" "$YEAR" "2026"
assert_eq "month echoes input" "$MONTH" "1"
assert_eq "costCenter echoes input" "$CC" "VERTRIEB"

# Pagination shape
assert_eq "take default" "$(json_field "$BODY" pagination.take)" "100"
assert_eq "skip default" "$(json_field "$BODY" pagination.skip)" "0"

# Transaction count: 3 invoices + 2 VERTRIEB expenses = 5
TX_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['transactions']))" <<< "$BODY")
assert_eq "transaction count (Jan VERTRIEB)" "$TX_LEN" "5"

# ───── 5. Sort order (ascending by date) ─────
echo
note "=== 2. Transactions date-sorted ascending ==="
SORTED=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
dates=[t['date'] for t in d['transactions']]
print('yes' if dates==sorted(dates) else 'no')
" <<< "$BODY")
assert_eq "dates sorted asc" "$SORTED" "yes"

# ───── 6. Totals match sum of returned rows ─────
echo
note "=== 3. Totals match sum of returned rows ==="
# Expected: revenue = 119+238+357 = 714, ust = 19+38+57 = 114
# expense = 50+80 = 130, vorsteuer = 8+12.8 = 20.8
TOT_REV=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['revenue'])" <<< "$BODY")
TOT_UST=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['ust'])" <<< "$BODY")
TOT_EXP=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['expense'])" <<< "$BODY")
TOT_VST=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['vorsteuer'])" <<< "$BODY")
assert_close "totals.revenue" "$TOT_REV" "714.00"
assert_close "totals.ust" "$TOT_UST" "114.00"
assert_close "totals.expense" "$TOT_EXP" "130.00"
assert_close "totals.vorsteuer" "$TOT_VST" "$EXPECTED_VST" 0.01

TOT_INV_CT=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['invoiceCount'])" <<< "$BODY")
TOT_EXP_CT=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['expenseCount'])" <<< "$BODY")
assert_eq "totals.invoiceCount" "$TOT_INV_CT" "3"
assert_eq "totals.expenseCount" "$TOT_EXP_CT" "2"

# ───── 7. Kind discrimination (invoice vs expense) ─────
echo
note "=== 4. Transaction kinds include invoice + expense ==="
KIND_INV=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(sum(1 for t in d['transactions'] if t['kind']=='invoice'))
" <<< "$BODY")
KIND_EXP=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(sum(1 for t in d['transactions'] if t['kind']=='expense'))
" <<< "$BODY")
assert_eq "invoice kind count" "$KIND_INV" "3"
assert_eq "expense kind count" "$KIND_EXP" "2"

# ───── 8. NULL-cc bucket via empty costCenter param ─────
echo
note "=== 5. NULL-cc bucket via empty costCenter param ==="
api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=1"
assert_status "200" "no cc → Nicht zugewiesen returns 200"

CC_DEFAULT=$(json_field "$BODY" costCenter)
assert_eq "default cc label" "$CC_DEFAULT" "Nicht zugewiesen"

# The empty-cc query should include Tier46-E3
# (60€ gross, NULL cc) plus baseline pre-existing
# rows in Jan.
TX_LEN_NULL=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['transactions']))" <<< "$BODY")
[[ "$TX_LEN_NULL" -ge 1 ]] \
  && pass "null-cc transactions include ≥1 row ($TX_LEN_NULL)" \
  || fail "null-cc transactions empty: $TX_LEN_NULL"

# ───── 9. NULL-cc bucket via explicit 'Nicht zugewiesen' string ─────
api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=1&costCenter=Nicht%20zugewiesen"
assert_status "200" "explicit 'Nicht zugewiesen' label returns 200"
CC_EXPLICIT=$(json_field "$BODY" costCenter)
assert_eq "explicit label echoed" "$CC_EXPLICIT" "Nicht zugewiesen"

# ───── 10. Pagination take/skip ─────
echo
note "=== 6. Pagination take=2 returns 2 rows + hasMore=true ==="
api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=1&costCenter=VERTRIEB&take=2"
assert_status "200" "take=2 returns 200"

TX_LEN_2=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['transactions']))" <<< "$BODY")
assert_eq "take=2 row count" "$TX_LEN_2" "2"
HAS_MORE=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['pagination']['hasMore'])" <<< "$BODY")
assert_eq "hasMore true" "$HAS_MORE" "True"

# ───── 11. Empty month → empty list ─────
echo
note "=== 7. Empty month → transactions=[] ==="
api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=3&costCenter=VERTRIEB"
assert_status "200" "empty month returns 200"
TX_LEN_EMPTY=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['transactions']))" <<< "$BODY")
assert_eq "empty month transactions" "$TX_LEN_EMPTY" "0"

# ───── 12. Bad inputs ─────
echo
note "=== 8. Bad inputs ==="
api_get "/api/v1/reports/cost-center-transactions"
assert_status "400" "missing companyId → 400"

api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=1999&month=1&costCenter=VERTRIEB"
assert_status "400" "invalid year → 400"

api_get "/api/v1/reports/cost-center-transactions?companyId=$COMPANY_ID&year=2026&month=13&costCenter=VERTRIEB"
assert_status "400" "month=13 → 400"

# ───── 13. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier46%';
SQL

summary
exit $?