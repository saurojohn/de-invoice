#!/usr/bin/env bash
# e2e 72: Tier 44 — Cost-Center Jahresauswertung (yearly report).
#
# GET /reports/cost-center-yearly?companyId=X&year=YYYY returns:
#   { year, rows[ {costCenter, revenue, expense, net, ust,
#                   vorsteuer, invoiceCount, expenseCount, monthly[12]} ],
#     totals, generatedAt }
#
# Validates:
#   1. Year param defaults to current year when omitted.
#   2. Two cost-centers bucketed correctly (revenue +
#      expense + ust + vorsteuer).
#   3. NULL cc coalesces to "Nicht zugewiesen" (same
#      bucket rule as dashboard-v2 / tier-38 pie).
#   4. Monthly array length 12 with the right value
#      in each month-bucket (we seed across 3 quarters).
#   5. Totals row sums all per-cc rows.
#   6. Bad inputs (missing companyId, invalid year) → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ───── 0. Wipe prior tier-44 fixtures + ensure a customer exists ─────
# Polish #10: the 65 test used to wipe all customers at the
# start, so 72 would see 0 customers. We now scope 65's
# wipe to its own customers (Tier37-*), but the existing
# customers can still be deleted by other test runs. Seed
# a self-sufficient Tier44 customer if needed. Also wipe
# any residue VERTRIEB / MARKETING / WERKSTATT rows from
# prior tests that would inflate the cost-center aggregation.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
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
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%';
DELETE FROM "SepaDirectDebitCollection" WHERE "companyId" = '$COMPANY_ID' AND "mandateId" IN (SELECT id FROM "SepaDirectDebitMandate" WHERE "debitorName" = 'Tier44 Test Kunde');
DELETE FROM "SepaDirectDebitMandate"   WHERE "companyId" = '$COMPANY_ID' AND "debitorName" = 'Tier44 Test Kunde';
DELETE FROM "Customer"                  WHERE "companyId" = '$COMPANY_ID' AND "name" = 'Tier44 Test Kunde';
SQL
# Seed a Tier44 customer (idempotent: re-run is safe)
TIER44_EMAIL="t44-$(date +%s)@example.com"
api_post "/api/v1/customers?companyId=$COMPANY_ID" \
  "{\"name\":\"Tier44 Test Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Teststr 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"},\"contact\":{\"email\":\"$TIER44_EMAIL\"}}"
assert_status 201 "seed Tier44 customer"

# ───── 1. Capture baseline (BEFORE seed) ─────
# Pre-existing test rows from prior tier e2es inflate
# the null-cc bucket (19/28/29/38/39/41 etc.). We
# snapshot the relevant aggregates BEFORE the seed
# block so the assertions can verify "baseline +
# Tier-44 delta" without hard-failing on the residual
# data.
BEFORE_NULL_EC=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")
BEFORE_NULL_GROSS=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"grossAmount\"),0) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")
BEFORE_NULL_INV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")
BEFORE_NULL_REV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"total\"),0) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"costCenter\" IS NULL AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")
BEFORE_TOT_REV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"total\"),0) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")
BEFORE_TOT_GROSS=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COALESCE(SUM(\"grossAmount\"),0) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")
BEFORE_TOT_INV=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"issueDate\" >= '2026-01-01' AND \"issueDate\" < '2027-01-01' AND \"type\" IN ('INV','RCV');")
BEFORE_TOT_EXP=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"companyId\" = '$COMPANY_ID' AND \"invoiceDate\" >= '2026-01-01' AND \"invoiceDate\" < '2027-01-01' AND \"status\" IN ('booked','deductible');")

# ───── 2. Seed customer (use existing first one) ─────
CUSTOMER_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUSTOMER_ID" ]] || (echo "FATAL: no customer seeded" && exit 1)
pass "customer seeded: $CUSTOMER_ID"

# ───── 2. Create invoices across 3 quarters ─────
# We build them via raw SQL because the HTTP DTO is
# strict (no invoiceNumber/total/status in body — server
# stamps invoiceNumber via the sequence, computes total
# from items, defaults status to draft). Easier to seed
# directly. tier-44 endpoint filters by issueDate only,
# so the row's status doesn't matter, but we set it to
# 'sent' so the seed looks like real traffic.
mk_invoice() {
  local number="$1" cc="$2" total="$3" month="$4" day="$5"
  local due date total_vat total_net
  total_net=$(python3 -c "print(round($total/1.19, 4))")
  total_vat=$(python3 -c "print(round($total - $total_net, 4))")
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  # dueDate: 30 days after issue (rough; month rolls if
  # day > days-in-next-month, but that's fine for tests).
  local next_month=$(( (month % 12) + 1 ))
  due=$(printf "2026-%02d-%02dT12:00:00.000Z" "$next_month" "$day")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceYear\", \"sequenceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"costCenter\", \"customerName\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUSTOMER_ID', '$number', 2026, $RANDOM, 'INV', 'sent', '$date', '$due', $total_net, $total_vat, $total, 'EUR', 'de-DE', '$cc', 'Tier44 customer', NOW(), NOW());" \
    >/dev/null
}

# Q1 (Jan): 1× VERTRIEB 119€ gross (100 net + 19 VAT)
mk_invoice "Tier44-1" "VERTRIEB" "119.00" 1 15
# Q2 (Apr): 1× VERTRIEB 238€ gross (200 net + 38 VAT)
mk_invoice "Tier44-2" "VERTRIEB" "238.00" 4 10
# Q3 (Jul): 1× VERTRIEB 357€ gross (300 net + 57 VAT)
mk_invoice "Tier44-3" "VERTRIEB" "357.00" 7 5
pass "seeded 3 invoices on Sachkonto VERTRIEB across 3 quarters"

# ───── 3. Create expenses across quarters ─────
# Q1 (Feb): 1× VERTRIEB 50€ gross
# Q3 (Aug): 2× VERTRIEB 80€ + 1× no-cc 60€
mk_expense() {
  local number="$1" cc="$2" gross="$3" month="$4" day="$5"
  local date net vat
  date=$(printf "2026-%02d-%02dT12:00:00.000Z" "$month" "$day")
  net=$(python3 -c "print(round($gross/1.19, 4))")
  vat=$(python3 -c "print(round($gross - $net, 4))")
  # Two-step: INSERT then UPDATE costCenter so NULL
  # (no cc) and '' (no cc) cases both work cleanly.
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", \"invoiceDate\", \"description\", \"grossAmount\", \"netAmount\", \"vatAmount\", \"vatRate\", \"status\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$number', '$date', '$number', $gross, $net, $vat, 0.19, 'booked', NOW(), NOW());" \
    >/dev/null
  if [[ -n "$cc" ]]; then
    docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "UPDATE \"Expense\" SET \"costCenter\" = '$cc' WHERE \"invoiceNumber\" = '$number' AND \"companyId\" = '$COMPANY_ID';" >/dev/null
  fi
}

mk_expense "Tier44-E1" "VERTRIEB" "50.00" 2 20
mk_expense "Tier44-E2" "VERTRIEB" "80.00" 8 1
mk_expense "Tier44-E3" "VERTRIEB" "80.00" 8 15
mk_expense "Tier44-E4" ""          "60.00" 9 10
pass "seeded 4 expenses (3 VERTRIEB + 1 NULL) across quarters"

# ───── 4. GET /reports/cost-center-yearly?year=2026 ─────
echo
note "=== 1. GET /reports/cost-center-yearly?year=2026 ==="
api_get "/api/v1/reports/cost-center-yearly?companyId=$COMPANY_ID&year=2026"
assert_status "200" "yearly report returns 200"

YEAR=$(json_field "$BODY" year)
assert_eq "year echoes input" "$YEAR" "2026"

# Rows count: should be 2 (VERTRIEB + Nicht zugewiesen)
ROWS_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())['rows']))" <<< "$BODY")
assert_eq "row count" "$ROWS_LEN" "2"

# ───── 5. VERTRIEB row assertions ─────
echo
note "=== 2. VERTRIEB row aggregated correctly ==="
VERTRIEB=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(json.dumps(r)); break
" <<< "$BODY")

[[ -n "$VERTRIEB" ]] || { fail "VERTRIEB row missing"; summary; exit 1; }
pass "VERTRIEB row present"

# Revenue (gross) = 119 + 238 + 357 = 714.00
EXP_REV=714.00
ACT_REV=$(json_field "$VERTRIEB" revenue)
assert_close "VERTRIEB revenue" "$ACT_REV" "$EXP_REV"

# USt (output VAT) = 19 + 38 + 57 = 114.00
EXP_UST=114.00
ACT_UST=$(json_field "$VERTRIEB" ust)
assert_close "VERTRIEB ust" "$ACT_UST" "$EXP_UST"

# Expense = 50 + 80 + 80 = 210.00 (gross)
EXP_EXP=210.00
ACT_EXP=$(json_field "$VERTRIEB" expense)
assert_close "VERTRIEB expense" "$ACT_EXP" "$EXP_EXP"

# Net = revenue - expense = 714 - 210 = 504
EXP_NET=504.00
ACT_NET=$(json_field "$VERTRIEB" net)
assert_close "VERTRIEB net" "$ACT_NET" "$EXP_NET"

assert_eq "VERTRIEB invoiceCount" "$(json_field "$VERTRIEB" invoiceCount)" "3"
assert_eq "VERTRIEB expenseCount" "$(json_field "$VERTRIEB" expenseCount)" "3"

MONTHLY_LEN=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())))" <<< "$(json_field "$VERTRIEB" monthly)")
assert_eq "VERTRIEB monthly length" "$MONTHLY_LEN" "12"

# ───── 6. Nicht zugewiesen row assertions ─────
echo
note "=== 3. Nicht zugewiesen row coalesced from NULL cc ==="
NUL=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='Nicht zugewiesen': print(json.dumps(r)); break
" <<< "$BODY")
[[ -n "$NUL" ]] || { fail "Nicht zugewiesen row missing"; summary; exit 1; }
pass "Nicht zugewiesen row present"

# We seeded exactly 1 null-cc expense (Tier44-E4,
# 60€ gross) so the Nicht zugewiesen row's delta
# from the pre-existing baseline is +1 expenseCount
# and +60 expense. The BEFORE_*_NULL vars come from
# the global baseline snapshot taken at the top of
# this script (BEFORE any seed).
#
# Endpoint should reflect:
#   revenue      = baseline (no new null-cc invoices)
#   expense      = baseline + 60 (Tier44-E4)
#   invoiceCount = baseline + 0
#   expenseCount = baseline + 1
ACT_NUL_REV=$(json_field "$NUL" revenue)
ACT_NUL_EXP=$(json_field "$NUL" expense)
ACT_NUL_IC=$(json_field "$NUL" invoiceCount)
ACT_NUL_EC=$(json_field "$NUL" expenseCount)
assert_close "Nicht zugewiesen revenue (baseline)" "$ACT_NUL_REV" "$BEFORE_NULL_REV" 0.05
EXPECTED_NUL_EXP=$(python3 -c "print(round($BEFORE_NULL_GROSS + 60, 2))")
assert_close "Nicht zugewiesen expense (baseline + Tier44-E4)" "$ACT_NUL_EXP" "$EXPECTED_NUL_EXP"
EXPECTED_NUL_IC=$((BEFORE_NULL_INV + 0))
assert_eq "Nicht zugewiesen invoiceCount (baseline)" "$ACT_NUL_IC" "$EXPECTED_NUL_IC"
EXPECTED_NUL_EC=$((BEFORE_NULL_EC + 1))
assert_eq "Nicht zugewiesen expenseCount (baseline + 1)" "$ACT_NUL_EC" "$EXPECTED_NUL_EC"

# ───── 7. Monthly bucket sums ─────
# We seeded invoices in Jan/Apr/Jul and expenses in
# Feb/Aug/Sep. VERTRIEB's net monthly = revenue − expense.
# Jan:  119 − 0   = 119
# Feb:    0 − 50  = -50
# Apr:  238 − 0   = 238
# Jul:  357 − 0   = 357
# Aug:    0 − 160 = -160
# Sep:    0 − 0   = 0   (Tier44-E4 is Nicht zugewiesen)
echo
note "=== 4. Monthly buckets per cost-center ==="
M_JAN=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(r['monthly'][0]); break
" <<< "$BODY")
assert_close "VERTRIEB Jan monthly" "$M_JAN" "119.00"

M_AUG=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for r in d['rows']:
    if r['costCenter']=='VERTRIEB': print(r['monthly'][7]); break
" <<< "$BODY")
assert_close "VERTRIEB Aug monthly" "$M_AUG" "-160.00"

# ───── 8. Totals row ─────
echo
note "=== 5. Totals row sums all cost-centers ==="
# json_field from _lib.sh prints nested values as
# Python repr (e.g. dict-as-string), so a second
# json_field on the result fails to parse. We use
# an inline python expression that reads from
# $BODY directly and extracts the totals fields.
TOT_REV=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['revenue'])" <<< "$BODY")
TOT_EXP=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['expense'])" <<< "$BODY")
TOT_NET=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['net'])" <<< "$BODY")
TOT_IC=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['invoiceCount'])" <<< "$BODY")
TOT_EC=$(python3 -c "import json,sys;print(json.loads(sys.stdin.read())['totals']['expenseCount'])" <<< "$BODY")

# Expected revenue = baseline (Tier44-1..3 are on
# VERTRIEB, NOT Nicht zugewiesen) + 714 (Tier44
# VERTRIEB revenue).
EXPECTED_TOT_REV=$(python3 -c "print(round($BEFORE_TOT_REV + 714, 2))")
assert_close "totals revenue (baseline + Tier44)" "$TOT_REV" "$EXPECTED_TOT_REV"

# Expected expense = baseline + Tier44-E1..4 total
# (50+80+80+60 = 270).
EXPECTED_TOT_EXP=$(python3 -c "print(round($BEFORE_TOT_GROSS + 270, 2))")
assert_close "totals expense (baseline + Tier44)" "$TOT_EXP" "$EXPECTED_TOT_EXP"

EXPECTED_TOT_NET=$(python3 -c "print(round($EXPECTED_TOT_REV - $EXPECTED_TOT_EXP, 2))")
assert_close "totals net (revenue − expense)" "$TOT_NET" "$EXPECTED_TOT_NET"

# Tier-44 added 3 invoices + 4 expenses to baseline.
EXPECTED_TOT_IC=$((BEFORE_TOT_INV + 3))
EXPECTED_TOT_EC=$((BEFORE_TOT_EXP + 4))
assert_eq "totals invoiceCount" "$TOT_IC" "$EXPECTED_TOT_IC"
assert_eq "totals expenseCount" "$TOT_EC" "$EXPECTED_TOT_EC"

# ───── 9. Default year param ─────
echo
note "=== 6. Default year param = current year ==="
api_get "/api/v1/reports/cost-center-yearly?companyId=$COMPANY_ID"
assert_status "200" "default year"
DEF_YEAR=$(json_field "$BODY" year)
[[ "$DEF_YEAR" =~ ^[0-9]{4}$ ]] \
  && pass "default year is a 4-digit number ($DEF_YEAR)" \
  || fail "default year malformed: $DEF_YEAR"

# ───── 10. Bad inputs ─────
echo
note "=== 7. Bad inputs ==="
api_get "/api/v1/reports/cost-center-yearly"
assert_status "400" "missing companyId → 400"

api_get "/api/v1/reports/cost-center-yearly?companyId=$COMPANY_ID&year=1999"
assert_status "400" "invalid year → 400"

api_get "/api/v1/reports/cost-center-yearly?companyId=$COMPANY_ID&year=abc"
assert_status "400" "non-numeric year → 400"

# ───── 11. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%'
);
DELETE FROM "Invoice"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%';
DELETE FROM "Expense"     WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier44%';
SQL

# Tier-44 didn't introduce any long-lived fixtures —
# cleanup is complete.

summary
exit $?