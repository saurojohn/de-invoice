#!/bin/bash
# Tier 840 — the Kassenbuch export of a period begins with the Übertrag.
#
# Tier 838 made the export the whole book in order, with the running
# Kassenbestand. For a period after the first entry (October, the year 2026),
# the cash carried in from before was in the first row's Bestand but nowhere
# on its own: the October book began "02.10. Einnahme 238 — Bestand 857" and
# the reader could not see where the 619 came from. Now the first row is the
# Übertrag, the Kassenbestand at the start of the period.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-534-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier840-e2e\",\"companyName\":\"$TAG Laden\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: company" || { fail "register"; summary; exit 1; }
Q="companyId=$C"
E() {
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/cashbook/entries?$Q" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$1")
  [[ "$code" == 201 ]] && pass "fixture: $2" || fail "fixture: $2 (HTTP $code)"
}
E '{"businessDate":"2026-09-01","type":"eroeffnung","description":"Anfangsbestand","amount":500}' "opening balance 500 on 01.09."
E '{"businessDate":"2026-09-15","type":"einnahme","description":"Tageslosung","amount":119,"vatRate":0.19}' "takings 119 on 15.09."
E '{"businessDate":"2026-10-02","type":"einnahme","description":"Tageslosung","amount":238,"vatRate":0.19}' "takings 238 on 02.10."
E '{"businessDate":"2026-10-05","type":"ausgabe","description":"Porto","amount":17}' "postage 17 on 05.10."
TMP=$(mktemp -d)
rows() { # from to → the rows as Datum|Typ|Beschreibung|Betrag|Bestand
  curl -sS -o "$TMP/k.csv" "$API/api/v1/cashbook/export?$Q&from=$1&to=$2" -H "x-user-id: $U" -H "x-company-id: $C"
  python3 -c "
import csv,sys
r=list(csv.reader(open(sys.argv[1],encoding='utf-8-sig'),delimiter=';'))
print(' / '.join('|'.join((x[0],x[1],x[2],x[5],x[9])) for x in r[1:]))" "$TMP/k.csv"
}
assert_eq "October: the Übertrag of 619 first, then the month (was: the 02.10. row first, the 619 only inside its Bestand)" \
  "$(rows 2026-10-01 2026-10-31)" \
  "2026-10-01|Übertrag|Kassenbestand vor dem 01.10.2026||619,00 / 2026-10-02|Einnahme|Tageslosung|238,00|857,00 / 2026-10-05|Ausgabe|Porto|17,00|840,00"
assert_eq "from the first entry on: no Übertrag, the book begins with its Eröffnung" \
  "$(rows 2026-09-01 2026-09-30)" \
  "2026-09-01|Eröffnung|Anfangsbestand|500,00|500,00 / 2026-09-15|Einnahme|Tageslosung|119,00|619,00"
assert_eq "a period with no entry of its own: the Übertrag alone (was: the header alone)" \
  "$(rows 2026-10-06 2026-10-31)" \
  "2026-10-06|Übertrag|Kassenbestand vor dem 06.10.2026||840,00"
rm -rf "$TMP"
summary
