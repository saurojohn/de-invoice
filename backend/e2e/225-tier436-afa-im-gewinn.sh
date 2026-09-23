#!/bin/bash
# Tier 436 — the booked AfA lowers the Gewinn of EÜR and Anlage S
#
# "AfA buchen" stores the AfA as an expense row with a negative amount.
# Measured before, 5 000 € revenue and one machine with 1 200 € AfA booked:
# Anlage G said 3 800 €. GuV said 6 200 € (7a = −1 200 subtracted from the
# revenue), the EÜR 5 000 € (no AfA line), Anlage S 6 200 € (4600 = −1 200).
# Anlage V, the rental form, took the machine's AfA as 8600 = −1 200.
# (Anlage V's own sign: spec 118.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-225-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier436-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

# 6 000 € over 60 months from January: 1 200 € AfA a year. Revenue 5 000 €.
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Maschine","anschaffungsDatum":"'$Y'-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
assert_eq "asset created" "$STATUS" "201"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"
assert_eq "AfA $Y booked: 1200" "$(py 'print(d["totalAnnualAfA"])')" "1200"
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business"}'
CUST=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CUST'","issueDate":"'$Y'-03-01","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":5000,"vatRate":0.19}]}'
INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'

note "=== the same Gewinn everywhere: 5000 - 1200 = 3800 ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV 7a (was -1200)" "$(py 'print([l["amount"] for l in d["cost"]["lines"] if l["position"]=="7a"][0])')" "1200"
assert_eq "GuV Jahresüberschuss (was 6200)" "$(py 'print(d["totals"]["jahresueberschuss"])')" "3800"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR 4600 AfA (was: no line)" "$(py 'print([l["amount"] for l in d["ausgaben"] if l["kennziffer"]=="4600"][0])')" "1200"
assert_eq "EÜR Gewinn (was 5000)" "$(py 'print(d["totals"]["gewinn"])')" "3800"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=$Y"
assert_eq "Anlage S 4600 (was -1200)" "$(py 'print([l["amount"] for l in d["ausgaben"] if l["kennziffer"]=="4600"][0])')" "1200"
assert_eq "Anlage S Gewinn (was 6200)" "$(py 'print(d["totals"]["gewinn"])')" "3800"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "Anlage G Gewinn (unchanged)" "$(py 'print(d["totals"]["gewinnVorKorrektur"])')" "3800"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$Y&month=12"
assert_eq "BWA Jahresergebnis (unchanged)" "$(py 'print(d["totals"]["jahresergebnisYtd"])')" "3800"
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=$Y"
assert_eq "Anlage V 8600: a machine is no rental (was -1200)" "$(py 'print([l["amount"] for l in d["werbungskosten"] if l["kennziffer"]=="8600"][0])')" "0"

summary
