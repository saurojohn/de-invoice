#!/bin/bash
# Tier 431 — money that went missing between the payment paths
#
# Measured before:
#   Sammelzahlung of 2 000 € over two open invoices (1 190 + 595): 1 785 €
#   applied, the remaining 215 € on no account — the customer's credit stayed 0
#   a customer credit of 110 € applied to an invoice: the customer statement
#   deducted it twice (closing balance 279,80 instead of 389,80, printed as
#   279.79999999999995), and the DATEV export took it for a bank receipt of its
#   own whenever it fell inside the period
#   a payment recorded with a time on the last day of a DATEV export period
#   ("endDate=2026-09-30" = 00:00) was in no export at all
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-220-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); FROM=$(date +%Y-%m-01); YEAR=$(date +%Y)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier431-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
cust() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\"}"; json_field "$BODY" id; }
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$FROM\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"; }
credit() { AS GET "/api/v1/customers/$1/credit-balance?companyId=$C"; P "d['balance']"; }

note "=== 1. a Sammelzahlung above what is open ==="
KA=$(cust Sammel); A1=$(inv "$KA" 1000); A2=$(inv "$KA" 500)
AS POST "/api/v1/customers/$KA/allocate-payment?companyId=$C" "{\"amount\":2000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "both invoices paid" "$STATUS/$(q "select string_agg(status,',' order by total desc) from \"Invoice\" where \"customerId\"='$KA'")" "201/paid,paid"
assert_eq "the 215 € remainder is the customer's credit (was: on no account)" "$(credit "$KA")" "215"
assert_eq "the payments add up to the 2 000 € received" "$(q "select round(sum(p.amount)) from \"Payment\" p join \"Invoice\" i on i.id=p.\"invoiceId\" where i.\"customerId\"='$KA'")" "2000"

note "=== 2. a customer credit applied to an invoice ==="
KB=$(cust Guthaben); X=$(inv "$KB" 1000); Y=$(inv "$KB" 420)
AS POST "/api/v1/invoices/$X/payments?companyId=$C" "{\"amount\":1300,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "fixture: 110 € overpaid → credit" "$(credit "$KB")" "110"
AS POST "/api/v1/customers/$KB/apply-credit?companyId=$C" "{\"invoiceId\":\"$Y\",\"amount\":110}"
assert_eq "applied, credit used up" "$STATUS/$(credit "$KB")" "201/0"
AS GET "/api/v1/customers/$KB/statement?companyId=$C&from=$YEAR-01-01&to=$TODAY"
assert_eq "statement: 499,80 − 110 = 389,80 open (was 279.79999999999995)" "$(P "d['closingBalance']")" "389.8"

note "=== 3. DATEV ==="
# The Sammelzahlung above is dated today 00:00; this one carries a time.
KC=$(cust Uhrzeit); Z=$(inv "$KC" 100)
AS POST "/api/v1/invoices/$Z/payments?companyId=$C" "{\"amount\":119,\"paymentDate\":\"${TODAY}T14:30:00.000Z\",\"paymentMethod\":\"bank_transfer\"}"
curl -sS -o /tmp/t431.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TODAY"
# Measured before: 3 085 — only 1 785 of the Sammelzahlung, and the 14:30
# payment cut off by the 00:00 end date (so was the credit, by the same
# accident; counted from the whole day it would have been a receipt of its own).
assert_eq "bank receipts: 2 000 + 1 300 + 119 — the credit is no receipt (was 3 085)" \
  "$(datev_rows /tmp/t431.csv | awk -F'\t' '$3=="1200" {s+=$5} END {printf "%.2f", s}')" "3419.00"

summary; exit $?
