#!/bin/bash
# Tier 442 — supplier credit notes (Lieferantengutschrift)
#
# Measured before: a supplier's credit note could not be recorded. Both
# expense endpoints required amounts ≥ 0 and rejected a creditNote field
# (400), the CSV import skipped negative rows. The input tax claimed on the
# original invoice stayed claimed in full (§ 17 UStG), the cost too. And the
# UStVA took Math.abs() of every expense and the BWA of every cost — a
# negative row, had one got in, would have ADDED input tax and cost.
#
# An invoice of 1 000 € + 19 %, a credit note of 200 € + 19 % and a CSV credit
# note of 10 € + 1,90 € from the same supplier: cost 790, input tax 150,10,
# owed to the supplier 940,10.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-231-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier442-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-1","description":"Ware","invoiceDate":"'$Y'-03-01","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190}'
assert_eq "the invoice" "$STATUS" "201"
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-1","description":"Gutschrift Retoure","invoiceDate":"'$Y'-03-15","netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238,"creditNote":true}'
assert_eq "a credit note can be recorded (was 400)" "$STATUS" "201"
assert_eq "stored negative" "$(py 'print(d["netAmount"], d["vatAmount"], d["grossAmount"])')" "-200 -38 -238"
GS=$(json_field "$BODY" id)
AS POST "/api/v1/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-2","description":"Bonus","invoiceDate":"'$Y'-04-01","netAmount":0,"vatAmount":0,"grossAmount":0,"creditNote":true}'
assert_eq "the other endpoint takes the flag too (was 400)" "$STATUS" "201"
AS POST "/api/v1/expenses/import?companyId=$C" '{"rows":[{"description":"Gutschrift CSV","invoiceDate":"'$Y'-04-02","supplierId":"'$S'","netAmount":"-10","vatRate":"0.19","vatAmount":"1.90"}]}'
assert_eq "CSV: a negative row is imported as a credit note (was an error)" "$(py 'print(d["imported"], d["errors"])')" "1 []"

note "=== the reports: cost 1000 - 200 - 10, input tax 190 - 38 - 1.90 ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y"
assert_eq "UStVA Vorsteuer 19 % (was 190: no credit note could be recorded)" "$(py 'print(round(d["vorsteuer"]["from19"],2))')" "150.1"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR Gewinn" "$(py 'print(d["totals"]["gewinn"])')" "-790"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV" "$(py 'print(d["totals"]["jahresueberschuss"])')" "-790"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$Y&month=12"
assert_eq "BWA (was -1000)" "$(py 'print(d["totals"]["jahresergebnisYtd"])')" "-790"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "Anlage G" "$(py 'print(d["totals"]["gewinnVorKorrektur"])')" "-790"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "Bilanz 4000: 1190 - 238 - 11.90 owed" \
  "$(py 'print([l["amount"] for s in d["passiva"] for l in s["lines"] if l.get("position")=="4000"][0])')" "940.1"

note "=== it is no bill ==="
AS GET "/api/v1/payments/unpaid?companyId=$C"
assert_eq "SEPA: only the invoice can be paid" "$(py 'print(sorted(e.get("invoiceNumber") or "" for e in (d if isinstance(d,list) else d.get("items",[]))))')" "['ER-1']"
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$Y'-03-20","type":"eroeffnung","description":"Anfangsbestand","amount":1000}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$Y'-03-20","type":"ausgabe","description":"bar","amount":238,"vatRate":0.19,"expenseId":"'$GS'"}'
assert_eq "cash book: a credit note is not paid from the till" "$STATUS" "400"

note "=== DATEV ==="
curl -sS -o /tmp/t442.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "the credit note on the other side of the Kreditor" \
  "$(datev_rows /tmp/t442.csv | awk -F'\t' '$1=="GS-1" {print $3":"$4":"$5":"$6}')" "70001:4900:238.00:S"
assert_eq "Kreditor balance: 1190 - 238 - 11.90" "$(datev_balance /tmp/t442.csv 70001)" "-940.10"

summary
