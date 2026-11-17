#!/bin/bash
# Tier 853 — a GWG is written off in full in its acquisition month.
#
# Measured before (a cross-check of assets and AfA, 17.11.2026): a printer
# of 700 €, type „GWG“, acquired on 10 February over 36 months, had 213,89 €
# of AfA in its first year (11/36 of it) and 486,11 € stayed in the balance
# sheet. § 6 Abs. 2 EStG lets an asset of at most 800 € be written off in the
# year it is acquired; choosing the type GWG is that choice. A „GWG“ of
# 2 000 € was taken as well.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
TAG="e2e-546-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier853-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"rechtsform":"GmbH","defaultVatMode":"standard","besteuerungsart":"soll"}'
asset() { # type cost months day → ID
  local b="{\"type\":\"$1\",\"bezeichnung\":\"$1 $2\",\"anschaffungsDatum\":\"$Y-$4\",\"anschaffungsKosten\":$2,\"nutzungsdauerMonate\":$3}"
  AS POST "/api/v1/assets?$q" "$b"; ID=$(json_field "$BODY" id)
}
afa() { AS GET "/api/v1/assets/booking-status?$q&year=$Y"; echo "$BODY" | python3 -c "import sys,json;print({a['bezeichnung']: a['computedAfA'] for a in json.load(sys.stdin)}.get('$1'))"; }

asset GWG 700 36 02-10; G=$ID
assert_status 201 "a printer of 700 €, type GWG, 36 months"
assert_eq "its AfA of the year is all of it: 700 € (was: 213,89 €)" "$(afa "GWG 700")" "700"
asset Betriebsausstattung 3600 36 03-15
assert_eq "an asset of another type still over its useful life: 10 months of 100 €" "$(afa "Betriebsausstattung 3600")" "1000"
AS GET "/api/v1/accounting/bilanz?$q&year=$Y"
assert_eq "the balance sheet keeps the shelf only: 2 600 € (was: 3 086,11 €)" \
  "$(echo "$BODY" | python3 -c "
import sys,json
def walk(o):
    if isinstance(o, dict):
        if 'Betriebs- und Geschäftsausstattung' in str(o.get('label', '')) and isinstance(o.get('amount'), (int, float)): yield o['amount']
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
print(sum(walk(json.load(sys.stdin)['aktiva'])))")" "2600"
AS GET "/api/v1/accounting/guv?$q&year=$Y"
assert_eq "the GuV's Abschreibungen: 1 700 €" "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print([l['amount'] for l in d['cost']['lines'] if l['position'] == '7a'])")" "[1700]"
AS POST "/api/v1/assets/book-afa-monthly?$q&year=$Y&month=2" '{}'
assert_eq "booked by month: all of it in February, the month it was acquired" \
  "$(PSQL "select coalesce(sum(-\"netAmount\"), 0)::numeric(10,2) from \"Expense\" where \"companyId\"='$C' and \"relatedAssetId\"='$G' and category like 'AfA%'")" "700.00"

asset GWG 2000 36 04-01
assert_status 400 "a „GWG“ of 2 000 € is refused (was: 201)"
[[ "$BODY" == *"höchstens 800"* && "$BODY" == *"Betriebsausstattung"* ]] && pass "…saying the limit and what to choose" || fail "message: $BODY"
AS PATCH "/api/v1/assets/$G?$q" '{"anschaffungsKosten":900}'
assert_status 400 "…nor can the printer be made a GWG of 900 €"
# a GWG over 800 € stored before this tier: depreciated over its useful life, as it was
PSQL "insert into \"Asset\" (id, \"companyId\", type, bezeichnung, \"anschaffungsDatum\", \"anschaffungsKosten\", \"nutzungsdauerMonate\", restwert, \"createdAt\", \"updatedAt\") values ('old-$TAG', '$C', 'GWG', 'Alt-GWG 1200', '$Y-01-01', 1200, 12, 0, now(), now())" >/dev/null
assert_eq "an old „GWG“ of 1 200 € over 12 months: 1 200 € in its first year, by months" "$(afa "Alt-GWG 1200")" "1200"
summary
