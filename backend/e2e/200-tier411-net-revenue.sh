#!/bin/bash
# Tier 411 — the income statements count revenue after the invoice discount
#
# Tier 409 fixed the tax figures; the income statements still took
# `eurSubtotal ?? subtotal` — the amount BEFORE the invoice discount. Measured
# with a 1 000 € invoice at 10 % off (customer pays 1 071 €) plus a 100 € 19 %
# + 100 € 7 % invoice, net revenue 1 100:
#   EÜR 4100 / Anlage S 4100 / GuV / BWA / GoBD archive / sales   1 200
#   Anlage G: everything on 2110 — its 19 % matcher took any invoice with VAT
#             and ran first, so 2120 (7 %) was never reached
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-200-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier411-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
issue() { # body-fragment
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-08-15\",$1}"
  local id total; id=$(json_field "$BODY" id); total=$(json_field "$BODY" total)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  # Tier 454: paid in full — the EÜR counts payments
  AS POST "/api/v1/invoices/$id/payments?companyId=$C" '{"amount":'$total',"paymentDate":"2026-08-20","paymentMethod":"bank_transfer"}'
  [[ "$STATUS" == 201 ]] || fail "payment: $STATUS $BODY"
}
issue '"discountPercent":10,"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]'
issue '"items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]'
pass "fixture: 1 000 € −10 % at 19 %, and 100 € 19 % + 100 € 7 % (net revenue 1 100)"

KZ() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(next((l['amount'] for l in d['einnahmen'] if l['kennziffer']==sys.argv[2]),'-'))" "$BODY" "$1"; }

note "=== 1. the tax-return annexes ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 4100 (was 1200)" "$(KZ 4100)" "1100"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "Anlage S 4100 (was 1200)" "$(KZ 4100)" "1100"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2026"
assert_eq "Anlage G 2110 = 900 + 100 (was 1200)" "$(KZ 2110)" "1000"
assert_eq "Anlage G 2120 = the 7 % line (was never reached)" "$(KZ 2120)" "100"

note "=== 2. the management reports ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "GuV revenue (was 1200)" \
  "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['revenue']['subtotal'])" "$BODY")" "1100"
AS GET "/api/v1/reports/bwa?companyId=$C&year=2026&month=8"
assert_eq "BWA Erlöse YTD (was 1200)" \
  "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['erloeseYtd'])" "$BODY")" "1100"
AS GET "/api/v1/reports/sales?companyId=$C&startDate=2026-01-01&endDate=2026-12-31"
assert_eq "sales report totalSales (was 1200)" "$(json_field "$BODY" totalSales)" "1100"

note "=== 3. the GoBD archive summary ==="
AS GET "/api/v1/accounting/gobd-archive/summary?companyId=$C&year=2026"
assert_eq "totalRevenueNet (was 1200)" "$(json_field "$BODY" totalRevenueNet)" "1100"
assert_eq "totalVat is the stated tax: 171 + 19 + 7" "$(json_field "$BODY" totalVat)" "197"

summary; exit $?
