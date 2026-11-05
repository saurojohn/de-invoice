#!/bin/bash
# Tier 800 — monthly AfA is booked in the months the asset is depreciated
#
# The monthly booking (and the automatic one on the 1st of each month) split
# the year's AfA into twelve equal parts, dated 31.01. … 31.12. Measured on a
# clock at 01.01.2027: an asset bought on 01.07.2026 for 12 000 € over 60
# months had 100 € of AfA booked on each month end from January, six months
# before it was bought; the year's total (1 200 €) was right, the months were
# not, and the BWA showed AfA in January.
#
# Now the year's AfA is spread over the months from the acquisition (or
# January) to the end of the useful life or the month of sale; the last of
# them takes the rounding remainder.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-500-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier799-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
asset() { # name date cost months → id
  local body="{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG $1\",\"anschaffungsDatum\":\"$2\",\"anschaffungsKosten\":$3,\"nutzungsdauerMonate\":$4}"
  AS POST "/api/v1/assets?companyId=$C" "$body"
  json_field "$BODY" id
}
months() { # asset year → "month:amount …"
  q "select string_agg(\"afaMonth\"||':'||(-\"netAmount\")::numeric(12,2), ' ' order by \"afaMonth\") from \"Expense\" where \"relatedAssetId\"='$1' and \"afaYear\"=$2 and \"afaReversedAt\" is null"
}

JULY=$(asset "Presse Juli" 2026-07-01 12000 60)
OCT=$(asset "Bohrer Oktober" 2026-10-01 1000 36)
SOLD=$(asset "Stapler verkauft" 2025-01-01 12000 60)
q "update \"Asset\" set \"verkauftAm\"='2026-09-15', \"verkaufsPreis\"=8000 where id='$SOLD'" >/dev/null
OLD=$(asset "Laptop alt" 2024-03-01 3600 36)

AS POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=2026" '{}'
assert_eq "booked" "$STATUS" "201"
assert_eq "bought 01.07.2026: July to December, 200 € each (was 100 € from January)" \
  "$(months "$JULY" 2026)" "7:200.00 8:200.00 9:200.00 10:200.00 11:200.00 12:200.00"
assert_eq "bought 01.10.2026 for 1 000 € over 36 months: Oct, Nov, Dec; December takes the cent" \
  "$(months "$OCT" 2026)" "10:27.78 11:27.78 12:27.77"
assert_eq "sold 15.09.2026: January to September (was all twelve months)" \
  "$(months "$SOLD" 2026)" "1:200.00 2:200.00 3:200.00 4:200.00 5:200.00 6:200.00 7:200.00 8:200.00 9:200.00"
assert_eq "the year's totals are as before: 1 200 + 83,33 + 1 800 + 1 200" \
  "$(q "select (-sum(\"netAmount\"))::numeric(12,2) from \"Expense\" where \"companyId\"='$C' and \"afaYear\"=2026 and category='AfA'")" "4283.33"
assert_eq "the BWA of January 2026 has no AfA of the July asset" \
  "$(q "select count(*) from \"Expense\" where \"relatedAssetId\"='$JULY' and \"invoiceDate\" < '2026-07-01'")" "0"

AS POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=2027" '{}'
assert_eq "useful life ending in February 2027: January and February only" \
  "$(months "$OLD" 2027)" "1:100.00 2:100.00"

AS POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=2026" '{}'
assert_eq "booking the year again books nothing" "$STATUS/$(json_field "$BODY" bookedCount)" "201/0"

summary
