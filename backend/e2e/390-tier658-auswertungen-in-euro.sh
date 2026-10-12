#!/bin/bash
# Tier 658 — what the company adds up is in euros: the dashboard, the sales
# reports, the cost centres, the archive's summary
#
# Tier 653 put the aging report and the sum of what is overdue in euros and
# noted that the dashboard and the sales reports had not been looked at. They
# added `Invoice.total` — the amount in the invoice's own currency. With one
# invoice over 11 900 USD (10 967,74 € at 1,0850) and one over 1 190 €:
#   dashboard         revenue 13 090, VAT 2 090, open 7 140 after 5 950 USD paid
#   /reports/sales    13 090 by customer, by month and by year; net 11 000
#   /reports/vat      net 11 000, VAT 2 090
#   /reports/customers  invoiced 13 090, paid 5 950, open 7 140
#   cost centres, the GoBD archive's summary: the same
# By hand: gross 12 157,74 €, VAT 1 941,15 €, net 10 216,59 €; half of the USD
# invoice paid leaves 5 483,87 + 1 190 = 6 673,87 € open.
#
# The test backend runs with fixed rates: 1 EUR = 1.0850 USD.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-390-$(date +%s%N | cut -c1-13)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
[[ "${EXCHANGE_RATES_MOCK:-}" == "1" ]] || { note "EXCHANGE_RATES_MOCK is not 1 — the fixed rates are needed"; summary; exit 0; }
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier658-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" "DE123456789"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Importhaus Nord GmbH","type":"business","address":{"street":"Hafenweg 3","postalCode":"20457","city":"Hamburg","country":"DE"}}'; K=$(field "d['id']")
inv() { # currency price cost-centre
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","currency":"'$1'","costCenter":"'$3'","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]}'
  local id; id=$(field "d['id']")
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}' >/dev/null
  echo "$id"
}
IU=$(inv USD 10000 EXPORT); IE=$(inv EUR 1000 INLAND)
AS POST "/api/v1/invoices/$IU/payments?companyId=$C" '{"amount":5950,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer","eurAmount":5400}'
assert_eq "fixture: 11 900 USD and 1 190 EUR issued, half of the USD invoice paid" "$STATUS" "201"

note "=== 1. the dashboard ==="
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "revenue, VAT and net of the year in euros (was 13090 / 2090 / 11000)" "$(field "(d['ytd']['revenue'], d['ytd']['ust'], d['ytd']['net'])")" "(12157.74, 1941.15, 10216.59)"
assert_eq "this month's bar of the chart" "$(field "d['byMonth'][-1]['revenue']")" "12157.74"
assert_eq "what is open: 5 950 USD at the invoice's rate + 1 190 € (was 7140)" "$(field "d['openReceivables']")" "6673.87"
AS GET "/api/v1/reports/dashboard-v2?companyId=$C"
assert_eq "the top customer's revenue" "$(field "d['topCustomers'][0]['revenue']")" "12157.74"
assert_eq "by cost centre" "$(field "sorted((r['costCenter'], r['revenue'], r['ust']) for r in d['costCenterBreakdown'])")" "[('EXPORT', 10967.74, 1751.15), ('INLAND', 1190, 190)]"

note "=== 2. the sales reports ==="
AS GET "/api/v1/reports/sales?companyId=$C&year=$YEAR"
assert_eq "net sales and VAT (was 11000 / 2090)" "$(field "(d['totalSales'], d['totalVat'])")" "(10216.59, 1941.15)"
assert_eq "by customer, by month, by year (was 13090 each)" "$(field "(d['byCustomer'][0]['totalAmount'], d['byMonth'][0]['totalAmount'], d['yearOverYear'][-1]['totalAmount'])")" "(12157.74, 12157.74, 12157.74)"
AS GET "/api/v1/reports/vat?companyId=$C&year=$YEAR"
assert_eq "VAT by rate: net, VAT, gross" "$(field "(d['byRate'][0]['netAmount'], d['byRate'][0]['vatAmount'], d['totalGross'])")" "(10216.59, 1941.15, 12157.74)"
AS GET "/api/v1/reports/customers?companyId=$C&year=$YEAR"
assert_eq "per customer: invoiced, paid, open (was 13090 / 5950 / 7140)" "$(field "(d['customers'][0]['totalAmount'], d['customers'][0]['paidAmount'], d['customers'][0]['pendingAmount'])")" "(12157.74, 5483.87, 6673.87)"
assert_eq "invoiced = paid + open" "$(field "round(d['summary']['totalAmount'] - d['summary']['totalPaid'] - d['summary']['totalPending'], 2)")" "0.0"

note "=== 3. cost centres ==="
AS GET "/api/v1/reports/cost-center-yearly?companyId=$C&year=$YEAR"
assert_eq "the year by cost centre" "$(field "sorted((r['costCenter'], r['revenue'], r['ust'], r['monthly'][$MONTH - 1]) for r in d['rows'])")" "[('EXPORT', 10967.74, 1751.15, 10967.74), ('INLAND', 1190, 190, 1190)]"
assert_eq "its total" "$(field "d['totals']['revenue']")" "12157.74"
AS GET "/api/v1/reports/cost-center-monthly?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "the month by cost centre, to the cent" "$(field "sorted((r['costCenter'], r['revenue'], r['net']) for r in d['rows'])")" "[('EXPORT', 10967.74, 10967.74), ('INLAND', 1190, 1190)]"
AS GET "/api/v1/reports/cost-center-budget-vs-actual?companyId=$C&year=$YEAR"
assert_eq "actual against budget" "$(field "sorted((r['costCenter'], r['actual'][$MONTH - 1]) for r in d['rows'])")" "[('EXPORT', 10967.74), ('INLAND', 1190)]"
AS GET "/api/v1/reports/cost-center-transactions?companyId=$C&year=$YEAR&costCenter=EXPORT"
echo "$BODY" | grep -q '"currency":"USD"' && pass "a single invoice in the list keeps its own amount and says its currency" || fail "the transaction list: $(echo "$BODY" | cut -c1-200)"

note "=== 4. the archive's summary ==="
AS GET "/api/v1/accounting/gobd-archive/summary?companyId=$C&year=$YEAR"
assert_eq "net revenue and VAT of the year (was 11000 / 2090)" "$(field "(d['totalRevenueNet'], d['totalVat'])")" "(10216.59, 1941.15)"

note "=== 5. the same figures as the tax reports ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "UStVA Kz 81: the base in whole euros, the tax to the cent" "$(field "[(k['value'], k['tax']) for k in d['kennzahlen'] if k['kz'] == '81'][0]")" "(10216.59, 1941.15)"

summary
