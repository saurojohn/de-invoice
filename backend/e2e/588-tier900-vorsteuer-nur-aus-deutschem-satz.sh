#!/bin/bash
# Tier 900 — input tax only from a rate German law has
#
# Measured: an expense at 50 %, one at 16 % dated today and a hotel bill from
# Paris with 20 % French tax were stored, and all of it went into Kz 66 of the
# UStVA (93,80 € Vorsteuer on four 100 € bills, of which 7,80 € — a § 24
# farmer's average rate — were deductible). A § 13b purchase at 50 % put 50 €
# into Kz 84 / 85; the cash book took a purchase at 50 % as well.
# § 15 Abs. 1 Satz 1 Nr. 1 UStG: only the tax owed by law is deductible;
# foreign VAT is refunded through the BZSt (§ 18g UStG), not by the UStVA.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-588-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier900-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
q="companyId=$C"
SUP_FR='{"name":"Hotel Paris 588","address":{"street":"Rue 1","city":"Paris","postalCode":"75001","country":"FR"}}'
AS POST "/api/v1/suppliers?$q" "$SUP_FR"; FR=$(field id)
SUP_DE='{"name":"Lieferant 588","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
AS POST "/api/v1/suppliers?$q" "$SUP_DE"; DE=$(field id)

# expense SUPPLIER DATE RATE VAT [EXTRA-JSON] — net 100; sets STATUS / BODY
expense() {
  local gross; gross=$(python3 -c "print(100 + $4)")
  local body="{\"supplierId\":\"$1\",\"description\":\"Beleg 588\",\"invoiceDate\":\"$2\",\"netAmount\":100,\"vatRate\":$3,\"vatAmount\":$4,\"grossAmount\":$gross,\"category\":\"Sonstiges\"${5:-}}"
  AS POST "/api/v1/expenses?$q" "$body"
}

note "=== 1. a rate German law does not have ==="
expense "$FR" "$TODAY" 0.2 20
assert_eq "a hotel bill from Paris, 20 % French tax as Vorsteuer: refused (was: Kz 66)" "$STATUS" "400"
assert_contains "…says foreign tax is no German Vorsteuer" "$BODY" "Ausländische Umsatzsteuer ist keine deutsche Vorsteuer"
expense "$DE" "$TODAY" 0.5 50
assert_eq "50 %: refused (was: Kz 66)" "$STATUS" "400"
assert_contains "…names the rate" "$BODY" "nicht 50 %"
expense "$DE" "$TODAY" 0.16 16
assert_eq "16 % dated today: refused (was: Kz 66)" "$STATUS" "400"
expense "$DE" "$TODAY" 0.5 0 ',"isReverseCharge":true'
assert_eq "§ 13b at 50 %: refused (was: 50 € in Kz 84 / 85)" "$STATUS" "400"
assert_contains "…German tax at 19 % or 7 %" "$BODY" "schuldet das Unternehmen deutsche Umsatzsteuer"
LINES='"taxLines":[{"vatRate":0.19,"netAmount":100,"vatAmount":19},{"vatRate":0.2,"netAmount":50,"vatAmount":10}]'
AS POST "/api/v1/expenses?$q" "{\"supplierId\":\"$DE\",\"description\":\"Zwei Saetze\",\"invoiceDate\":\"$TODAY\",\"category\":\"Sonstiges\",$LINES}"
assert_eq "a 20 % VAT line next to a 19 % one: refused" "$STATUS" "400"
USTVA_EXP="{\"description\":\"UStVA-Seite\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.5,\"vatAmount\":50,\"grossAmount\":150}"
AS POST "/api/v1/ustva/expenses?$q" "$USTVA_EXP"
assert_eq "the UStVA page's expense at 50 %: refused" "$STATUS" "400"

note "=== 2. what stays allowed ==="
expense "$FR" "$TODAY" 0.2 0
assert_eq "the Paris bill with its tax as cost (0 € Vorsteuer): taken" "$STATUS" "201"
expense "$DE" "$TODAY" 0.078 7.8
assert_eq "a § 24 farmer at 7,8 % (since 2025): taken" "$STATUS" "201"
expense "$DE" "2024-06-03" 0.09 9
assert_eq "…at 9,0 % in 2024: taken" "$STATUS" "201"
expense "$DE" "2024-06-03" 0.078 7.8
assert_eq "…but 7,8 % in 2024: refused" "$STATUS" "400"
expense "$DE" "2020-11-16" 0.16 16
assert_eq "16 % on a bill of November 2020: taken" "$STATUS" "201"
OLD=$(field id)
expense "$DE" "$TODAY" 0.19 19
assert_eq "19 %: taken" "$STATUS" "201"
E19=$(field id)
expense "$DE" "$TODAY" 0.19 0 ',"isReverseCharge":true'
assert_eq "§ 13b at 19 %: taken" "$STATUS" "201"

note "=== 3. editing ==="
AS PUT "/api/v1/expenses/$E19?$q" '{"vatRate":0.2,"vatAmount":20,"grossAmount":120}'
assert_eq "a 19 % expense changed to 20 %: refused" "$STATUS" "400"
AS PUT "/api/v1/expenses/$OLD?$q" "{\"invoiceDate\":\"$TODAY\"}"
assert_eq "the 16 % bill of 2020 moved to today: refused" "$STATUS" "400"
AS PUT "/api/v1/expenses/$OLD?$q" '{"notes":"geprüft"}'
assert_eq "…its notes can still be changed" "$STATUS" "200"

note "=== 4. the CSV import ==="
ROWS="[{\"description\":\"CSV FR\",\"invoiceDate\":\"$TODAY\",\"supplierId\":\"$FR\",\"invoiceNumber\":\"F-588\",\"netAmount\":\"100\",\"vatRate\":\"0.2\",\"vatAmount\":\"20\"},{\"description\":\"CSV DE\",\"invoiceDate\":\"$TODAY\",\"supplierId\":\"$DE\",\"invoiceNumber\":\"D-588\",\"netAmount\":\"100\",\"vatRate\":\"0.19\",\"vatAmount\":\"19\"}]"
AS POST "/api/v1/expenses/import?$q" "{\"rows\":$ROWS}"
assert_eq "the 20 % row reported (row 2), the 19 % row imported" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d['imported'], [e['row'] for e in d['errors']], 'keine deutsche Vorsteuer' in d['errors'][0]['error'])" "$BODY")" \
  "1 [2] True"

note "=== 5. the cash book ==="
cash() { AS POST "/api/v1/cashbook/entries?$q" "{\"businessDate\":\"$TODAY\",\"type\":\"$1\",\"description\":\"Kasse 588\",\"amount\":$2,\"vatRate\":$3}"; }
cash einnahme 150 0.5
assert_eq "a cash sale at 50 %: refused" "$STATUS" "400"
assert_contains "…a sale in Germany is at 19 % or 7 %" "$BODY" "Ein Barverkauf ist ein Umsatz im Inland"
cash einnahme 238 0.19
assert_eq "a cash sale at 19 %: taken" "$STATUS" "201"
cash ausgabe 150 0.5
assert_eq "a cash purchase at 50 %: refused (was: taken)" "$STATUS" "400"
cash ausgabe 11.9 0.19
assert_eq "a cash purchase at 19 %: taken" "$STATUS" "201"
CASH=$(field id)
AS PUT "/api/v1/cashbook/entries/$CASH?$q" '{"vatRate":0.5}'
assert_eq "…changed to 50 %: refused" "$STATUS" "400"

note "=== 6. the UStVA ==="
AS GET "/api/v1/ustva/compute?$q&year=$Y&month=$M"
assert_eq "Vorsteuer 19 % = 19 + 19 (CSV) + 1,90 (cash); other rates = 7,80 (the farmer); nothing from the refused" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1])['vorsteuer'];print(d['from19'], d['fromOther'], d['fromReverseCharge'])" "$BODY")" \
  "39.9 7.8 19"

summary
