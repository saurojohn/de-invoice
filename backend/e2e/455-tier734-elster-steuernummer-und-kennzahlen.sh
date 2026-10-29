#!/bin/bash
# Tier 734 — the UStVA for ELSTER: the 13-digit Steuernummer, whole-euro
# bases, Kz 83 as ELSTER computes it
#
# 1. The Steuernummer. ELSTER takes it in the 13-digit federal form: the
#    four-digit number of the Finanzamt, a 0, district, distinguishing number,
#    check digit — Bayern's „181/815/08155" is 9181081508155. The export
#    appended „00" (1818150815500) or put a 0 before and 00 after a 10-digit
#    number: no Land writes it so. The printed form does not say its Land
#    (10 and 11 digits fit several), so the company names the Land of its
#    Finanzamt (Company.bundesland); the number is checked against it.
# 2. The amounts. A tax base goes into the form in whole euros, a tax amount
#    with cents; ELSTER computes the tax of Kz 81 / 86 / 89 / 93 from the
#    whole-euro base, and Kz 83 from that. The export wrote cents
#    („B-Kz081=+000000100060") and the invoices' Kz 83.
# 3. Zeitraum 01–12 for a month, 41–44 for a quarter (Kz 10: spec 254).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-455-$(date +%s%N | cut -c1-13)"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier734-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111111
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { AS PUT "/api/v1/companies/$C?companyId=$C" "$1"; }

note "=== 1. the Land of the Finanzamt, and the Steuernummer checked against it ==="
company '{"taxId":"181/815/08155"}'
assert_eq "fixture: a Bavarian Steuernummer, no Land yet" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
sent() { # net rate date
  local body="{\"customerId\":\"$K\",\"issueDate\":\"$3\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":$2}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$body"
  AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
}
sent 1000.60 0.19 2026-09-03; sent 100.90 0.07 2026-09-04
EXP='{"invoiceNumber":"ER-455","description":"Material","invoiceDate":"2026-09-05","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
AS POST "/api/v1/ustva/expenses?companyId=$C" "$EXP"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
DATA="$BODY"
assert_eq "fixture: September — 1 000,60 at 19 % (190,11), 100,90 at 7 % (7,06), input tax 19,00, payable 178,17" \
  "$(P "(d['salesByRate'][0]['net'], d['salesByRate'][0]['vat'], d['salesByRate'][1]['net'], d['salesByRate'][1]['vat'], d['vorsteuerSum'], d['differenzbetrag'])")" \
  "(1000.6, 190.11, 100.9, 7.06, 19, 178.17)"
FILING=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$DATA")
AS POST "/api/v1/ustva/filings?companyId=$C" "$FILING"
FID=$(json_field "$BODY" id)
xml() { AS GET "/api/v1/ustva/filings/$FID/elster-xml?companyId=$C${1:-}"; }
xml
assert_eq "without the Land: no XML, and why (was: 1818150815500 — 11 digits + \"00\")" "$STATUS/$(P "'Bundesland' in d['message']")" "400/True"
xml "&format=ascii"
assert_eq "…the list to transcribe is still there, with the number as entered" "$STATUS/$(grep -c '^# Steuernr.: *181/815/08155 (ELSTER-Form: ' <<<"$BODY")" "200/1"

company '{"bundesland":"XX"}'
assert_eq "a Land that is none: 400" "$STATUS" "400"
company '{"bundesland":"BE"}'
assert_eq "Berlin for a Bavarian number: 400, says how Berlin writes it" "$STATUS/$(P "'Berlin' in d['message'] and '10' in d['message']")" "400/True"
company '{"bundesland":"BY"}'
assert_eq "Bayern: taken" "$STATUS/$(P "d['bundesland']")" "200/BY"
company '{"taxId":"21/815/08150"}'
assert_eq "…and then a number of another Land refused" "$STATUS" "400"
AS GET "/api/v1/companies/$C?companyId=$C"
assert_eq "…the stored one unchanged" "$(P "(d['taxId'], d['bundesland'])")" "('181/815/08155', 'BY')"

note "=== 2. the XML: the 13-digit number, whole-euro bases, Kz 83 as ELSTER computes it ==="
xml
XML="$BODY"
KZ() { python3 -c "import re,sys;m=re.search(r'<%s>([^<]+)</%s>' % (sys.argv[2], sys.argv[2]), sys.argv[1]);print(m.group(1) if m else '-')" "$XML" "$1"; }
assert_eq "Steuernummer 9181081508155 (Bayern: 9 + 181, a 0, 815 0815 5)" "$(KZ Steuernummer)" "9181081508155"
assert_eq "Zeitraum 09" "$(KZ Zeitraum)" "09"
assert_eq "Kz 81 / Kz 86 in whole euros (was 100060 / 10090 cents)" "$(KZ Kz81)/$(KZ Kz86)" "1000/100"
assert_eq "Kz 66 with cents" "$(KZ Kz66)" "19.00"
assert_eq "Kz 83 = 1 000 × 19 % + 100 × 7 % − 19,00 = 178,00 — as ELSTER computes it (was the invoices' 178,17)" "$(KZ Kz83)" "178.00"
AS GET "/api/v1/ustva/filings/$FID/elster-xml?companyId=$C&format=ascii"
assert_eq "the list: the 13-digit number, Kz 83 as ELSTER computes it, the invoices' figure named" \
  "$(grep -c '^# Steuernr.: *9181081508155$' <<<"$BODY")/$(grep -o '^B-Kz083=[-+0-9]*' <<<"$BODY")/$(grep -c 'nach der Steuer laut Rechnungen 178.17' <<<"$BODY")" \
  "1/B-Kz083=+000000017800/1"

note "=== 3. a quarter ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&quarter=3"
Q3=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$Q3"
FID=$(json_field "$BODY" id)
xml
XML="$BODY"
assert_eq "Q3 is Zeitraum 43 (was <Quartal>3</Quartal>); Kz 81 the quarter's, in whole euros" "$(KZ Zeitraum)/$(KZ Kz81)" "43/1000"

AS GET "/api/v1/ustva/compute?companyId=$C&year=2026"
YEARLY=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$YEARLY"
FID=$(json_field "$BODY" id)
xml
assert_eq "a filing of the whole year: no Voranmeldung, says why (was a file without Zeitraum code)" "$STATUS/$(P "'UStJA' in d['message']")" "400/True"

note "=== 4. a number given in the 13-digit form ==="
company '{"taxId":"9181081508155","bundesland":"BY"}'
assert_eq "taken" "$STATUS" "200"
company '{"taxId":"9181181508155"}'
assert_eq "not with another digit than 0 in the fifth place" "$STATUS" "400"
company '{"taxId":"1121081508150"}'
assert_eq "not a Berlin number with Bayern" "$STATUS" "400"

summary
