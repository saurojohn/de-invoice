#!/bin/bash
# Tier 591 — the dashboard's profit is net revenue less net expenses
#
# GET /reports/dashboard returned ytd.net = ytd.revenue − ytd.expenses, where
# revenue is the invoices' gross total and expenses the expenses' net amount:
# a "Gewinn YTD" too high by the year's output VAT (seen in the page walk:
# 3 387,42 € on the tile, 2 935,72 € net).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-354-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier591-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Beratung","quantity":1,"unit":"Std","unitPrice":1000,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]}'
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Miete","invoiceNumber":"M-1","invoiceDate":"'$TODAY'","netAmount":400,"vatRate":0.19,"vatAmount":76,"grossAmount":476}'
assert_eq "fixture: an invoice of 1 100 net + 197 VAT and an expense of 400 net + 76 VAT" "$STATUS" "201"

AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "revenue (gross), its VAT, expenses (net), their VAT — as before" "$(py 'y=d["ytd"];print(y["revenue"], y["ust"], y["expenses"], y["vorsteuer"])')" "1297 197 400 76"
assert_eq "the profit is 1 100 − 400 = 700 (was 897: gross revenue less net expenses)" "$(py 'print(d["ytd"]["net"])')" "700"
assert_eq "…and the key set is unchanged" "$(py 'print(",".join(sorted(d["ytd"].keys())))')" "countExpenses,countInvoices,expenses,net,revenue,ust,vorsteuer"
AS GET "/api/v1/reports/pnl?companyId=$C&year=$(date +%Y)"
assert_eq "the P&L says the same" "$(py 'print("%.2f" % sum(m["operatingResult"] for m in d["months"]))')" "700.00"
# Tier 607: figures to the cent — the P&L returned float differences (2642.8599999999997)
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Porto","invoiceNumber":"P-1","invoiceDate":"'$TODAY'","netAmount":57.14,"vatRate":0.19,"vatAmount":10.86,"grossAmount":68}'
AS GET "/api/v1/reports/pnl?companyId=$C&year=$(date +%Y)"
assert_eq "no amount in the P&L has more than two decimals" "$(py 'v=[x for m in d["months"] for k,x in m.items() if isinstance(x,float)]+[x for x in d["ytd"].values() if isinstance(x,float)];print(sum(1 for x in v if round(x,2)!=x), len(v)>0)')" "0 True"
assert_eq "…and the result is 1 100 − 400 − 57,14" "$(py 'print("%.2f" % sum(m["operatingResult"] for m in d["months"]), d["ytd"]["operatingResult"])')" "642.86 642.86"
summary
