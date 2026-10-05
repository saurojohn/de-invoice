#!/bin/bash
# Tier 523 — the three amounts of an expense belong together
#
# Measured before: net 100 + VAT 19 with gross 500 was stored (the EÜR and the
# UStVA read net and VAT, the payment and the Kreditor the gross); net 100 at
# 19 % with 90 € VAT was stored and the 90 € went into the Vorsteuer; 19 € VAT
# at 0 % too. On both expense routes, the edit and the CSV import.
#
# Now: gross = net + VAT; the VAT is not more than the rate yields on the net
# (with a margin for per-line rounding). Less VAT stays allowed — a
# reverse-charge bill has none, a non-deductible part is cost.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-308-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier523-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
DAY="2026-09-15"
ex() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"$TAG\",\"invoiceDate\":\"$DAY\",$1}"; }
ex2() { AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"$TAG\",\"invoiceDate\":\"$DAY\",$1}"; }
count() { q "select count(*) from \"Expense\" where \"companyId\"='$C'"; }

note "=== the UStVA page's route ==="
ex '"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":500'
assert_eq "100 + 19 = 500: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Bruttobetrag' in d['message']")" "True"
ex '"netAmount":100,"vatRate":0.19,"vatAmount":90,"grossAmount":190'
assert_eq "90 € VAT on 100 at 19 %: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'höher als 19 %' in d['message']")" "True"
ex '"netAmount":100,"vatRate":0,"vatAmount":19,"grossAmount":119'
assert_eq "19 € VAT at 0 %: 400 (was 201)" "$STATUS" "400"
ex '"netAmount":100,"vatRate":0.19,"vatAmount":-19,"grossAmount":81'
assert_eq "net and VAT with different signs: 400" "$STATUS" "400"
assert_eq "…nothing stored" "$(count)" "0"

ex '"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119'
assert_eq "100 + 19 = 119: recorded" "$STATUS" "201"
E=$(json_field "$BODY" id)
ex '"netAmount":1000,"vatRate":0.19,"vatAmount":190.07,"grossAmount":1190.07'
assert_eq "7 cents of per-line rounding: recorded" "$STATUS" "201"
ex '"netAmount":2000,"vatRate":0.19,"vatAmount":0,"grossAmount":2000,"isReverseCharge":true'
assert_eq "a reverse-charge bill without VAT: recorded" "$STATUS" "201"
ex '"netAmount":109.5,"vatRate":0.19,"vatAmount":9.5,"grossAmount":119'
assert_eq "half the VAT not deductible, entered as cost: recorded" "$STATUS" "201"
ex '"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119,"creditNote":true'
assert_eq "a credit note: recorded, negative in all three" "$STATUS/$(P "float(d['netAmount'])+float(d['vatAmount'])-float(d['grossAmount'])")/$(P "float(d['grossAmount'])")" "201/0.0/-119.0"

note "=== the edit ==="
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" '{"grossAmount":500}'
assert_eq "its gross to 500: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" '{"vatAmount":90,"grossAmount":190}'
assert_eq "its VAT to 90: 400 (was 200)" "$STATUS" "400"
assert_eq "…the row is as it was" "$(q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||\"grossAmount\"::numeric(12,2) from \"Expense\" where id='$E'")" "100.00/19.00/119.00"
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" '{"netAmount":200}'
assert_eq "its net to 200: VAT and gross follow" "$STATUS/$(q "select \"vatAmount\"::numeric(12,2)||'/'||\"grossAmount\"::numeric(12,2) from \"Expense\" where id='$E'")" "200/38.00/238.00"
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" '{"description":"umbenannt"}'
assert_eq "an edit of the text: fine" "$STATUS" "200"

note "=== the expenses route and the CSV import ==="
BEFORE=$(count)
ex2 '"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":500'
assert_eq "POST /expenses, 100 + 19 = 500: 400 (was 201)" "$STATUS" "400"
ex2 '"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119'
assert_eq "…consistent: recorded" "$STATUS" "201"
AS POST "/api/v1/expenses/import?companyId=$C" "{\"rows\":[
  {\"description\":\"$TAG ok\",\"invoiceDate\":\"$DAY\",\"supplierName\":\"$TAG Lieferant\",\"netAmount\":\"100\",\"vatRate\":\"0.19\"},
  {\"description\":\"$TAG brutto\",\"invoiceDate\":\"$DAY\",\"supplierName\":\"$TAG Lieferant\",\"netAmount\":\"100\",\"vatRate\":\"0.19\",\"vatAmount\":\"19\",\"grossAmount\":\"500\"},
  {\"description\":\"$TAG steuer\",\"invoiceDate\":\"$DAY\",\"supplierName\":\"$TAG Lieferant\",\"netAmount\":\"100\",\"vatRate\":\"0.19\",\"vatAmount\":\"90\"}
]}"
assert_eq "import: one row in, two reported (were all in)" "$(P "d['imported']")/$(P "len(d['errors'])")" "1/2"
assert_eq "…with the reason" "$(P "'Bruttobetrag' in d['errors'][0]['error']")/$(P "'höher als' in d['errors'][1]['error']")" "True/True"
assert_eq "…two more rows in all" "$(( $(count) - BEFORE ))" "2"

summary
