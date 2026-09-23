#!/bin/bash
# Tier 437 — an AfA booking is no supplier invoice
#
# "AfA buchen" stores the AfA as an Expense row with a negative amount. The
# reports about bills and money took it for a supplier invoice. Measured with
# a machine (6 000 € over 60 months, 1 200 € AfA a year) and one unpaid
# supplier invoice of 119 €: the balance sheet owed suppliers 119 − 1 200;
# DATEV exported "Kreditor 70000 an 4900, 1 200 S" dated 30.12; the cash-flow
# forecast and the dashboard showed −1 200 € of expenses; the P&L lowered the
# other expenses by the AfA (a month with nothing else: max(0, −1 200) = 0).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-226-$(date +%s%N | cut -c1-13)"
Y=$(date +%Y); P=$((Y - 1))

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier437-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Fräse","anschaffungsDatum":"'$P'-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
assert_eq "asset created" "$STATUS" "201"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$P"
assert_eq "AfA $P booked" "$(py 'print(d["totalAnnualAfA"])')" "1200"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"
assert_eq "AfA $Y booked" "$(py 'print(d["totalAnnualAfA"])')" "1200"
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'
S=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-1","description":"Material","invoiceDate":"'$P'-03-01","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
assert_eq "an unpaid supplier invoice of 119" "$STATUS" "201"

note "=== balance sheet $P ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$P"
assert_eq "4000 Verbindlichkeiten L+L = the supplier invoice only (was -1081)" \
  "$(py 'print([l["amount"] for s in d["passiva"] for l in s["lines"] if l.get("position")=="4000"][0])')" "119"

note "=== DATEV $P ==="
curl -sS -o /tmp/t437.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$P-01-01&endDate=$P-12-31"
AFA_ROW=$(datev_rows /tmp/t437.csv | awk -F'\t' '$1 ~ /^AFA-/ {print $1":"$3":"$4":"$5":"$6":"$9}')
assert_eq "AfA: 4830 Abschreibungen an 0210 Maschinen, 1200 S, 31.12" "$AFA_ROW" "AFA-$P:4830:0210:1200.00:S:3112"
assert_eq "no AfA on a Kreditor (was 70000 an 4900)" \
  "$(datev_rows /tmp/t437.csv | awk -F'\t' '$8 ~ /^AfA/ && $3 ~ /^7/' | wc -l | tr -d ' ')" "0"
assert_eq "the supplier invoice still is on its Kreditor" "$(datev_balance /tmp/t437.csv 70001)" "-119.00"

note "=== P&L $P ==="
AS GET "/api/v1/reports/pnl?companyId=$C&year=$P"
assert_eq "other expenses: 100 + AfA 1200 (was 100)" "$(py 'print(round(d["ytd"]["materialExpenses"]+d["ytd"]["otherExpenses"],2))')" "1300"

note "=== cash flow and dashboard ==="
AS GET "/api/v1/reports/cashflow?companyId=$C&months=12"
assert_eq "cash-flow forecast: the AfA moves no money (was -1200)" "$(py 'print(sum(m["outgoing"] for m in d["months"]))')" "0"
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard: no negative monthly expenses (was -1200 in a December)" \
  "$(py 'print(min([m["expenses"] for m in d["byMonth"]] + [0]))')" "0"

note "=== cost centres $P ==="
AS GET "/api/v1/reports/cost-center-yearly?companyId=$C&year=$P"
assert_eq "cost centres: the supplier invoice only (was 119 - 1200)" "$(py 'print(d["totals"]["expense"])')" "119"

summary
