#!/bin/bash
# Tier 438 — Anlage G and the Gewerbesteuer estimate
#
# Measured before, with 50 050 € revenue, three uncategorised expenses of
# 100 €, rent 12 000 €, car costs 2 000 € and 1 200 € AfA booked:
#   - Betriebsausgaben +12 900: real expenses were added to the revenue with
#     their positive amount, and the fallback line 2890 took one expense per
#     category (100 of 300); only the negative AfA row lowered the result
#   - Gewinn 62 950 (right: 34 550)
#   - Hinzurechnung 3 000 (25 % of the rent; § 8 Nr. 1 GewStG: ¼ of the
#     financing shares above 200 000 € — here 0); Kürzung 1 000 (50 % of the
#     car costs — no Kürzung of § 9 GewStG)
#   - Freibetrag 100 000 (§ 11: 24 500), no rounding to full 100 €
#   - estimate: Messbetrag × Hebesatz 400 instead of × 400 % — 100 times
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-227-$(date +%s%N | cut -c1-13)"
Y=2025

company() {
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier438-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
revenue() { # net
  AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business"}'
  local cust inv; cust=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$cust'","issueDate":"'$Y'-03-01","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":'$1',"vatRate":0.19}]}'
  inv=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$inv/status?companyId=$C" '{"status":"sent"}'
}
expense() { # net category
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-'$RANDOM'","description":"Beleg","invoiceDate":"'$Y'-04-01","netAmount":'$1',"vatRate":0,"vatAmount":0,"grossAmount":'$1${2:+,\"category\":\"$2\"}'}'
  [[ "$STATUS" == "201" ]] || fail "expense $1 $2: $STATUS $BODY"
}
supplier() {
  AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'
  S=$(json_field "$BODY" id)
}

company "$TAG"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
supplier
revenue 50050
expense 100; expense 100; expense 100
expense 12000 Miete
expense 2000 Kfz
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Maschine","anschaffungsDatum":"'$Y'-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"
assert_eq "AfA booked" "$(py 'print(d["totalAnnualAfA"])')" "1200"

AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
T() { py "print(d['totals']['$1'])"; }
L() { py "print([l['amount'] for l in d['$1'] if l['kennziffer']=='$2'][0])"; }
assert_eq "2890 Sonstige: all three expenses, as a cost (was 100)" "$(L betriebsausgaben 2890)" "-300"
assert_eq "2200 Miete (was 12000)" "$(L betriebsausgaben 2200)" "-12000"
assert_eq "2500 AfA" "$(L betriebsausgaben 2500)" "-1200"
assert_eq "Betriebsausgaben (was 12900)" "$(T betriebsausgabenTotal)" "-15500"
assert_eq "Gewinn = 50050 - 15500 (was 62950)" "$(T gewinnVorKorrektur)" "34550"
assert_eq "Gewinn as GuV / EÜR" "$(T gewinnVorKorrektur)" \
  "$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/euer?companyId=$C&year=$Y" | python3 -c 'import sys,json;print(json.load(sys.stdin)["totals"]["gewinn"])')"
assert_eq "4100: rent is far below 200 000 € of financing shares (was 3000)" "$(L hinzurechnungen 4100)" "0"
assert_eq "5100: no Kürzung for car costs (was 1000)" "$(L kurzungen 5100)" "0"
assert_eq "Freibetrag § 11 GewStG (was 100000)" "$(T freibetrag)" "24500"
assert_eq "rounded down to 100, less Freibetrag: 34500 - 24500 (was 0)" "$(T gewerbeertragNachFreibetrag)" "10000"
assert_eq "estimate: 10000 x 3.5 % x 400 %" "$(T gewerbesteuerSchaetzung)" "1400"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=$Y"
assert_eq "GewSt Kz 10 the same" "$(py 'print([l["amount"] for l in d["lines"] if l["kennziffer"]=="10"][0])')" "1400"

note "=== § 8 Nr. 1: a quarter of the financing shares above 200 000 € ==="
company "$TAG-b"
supplier
revenue 1000000
expense 450000 Miete      # 50 %: 225 000
expense 100000 Leasing    # 20 %:  20 000
expense 5000 Schuldzinsen # 100 %:  5 000
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "4100 = (225000 + 20000 + 5000 - 200000) / 4" "$(L hinzurechnungen 4100)" "12500"

summary
