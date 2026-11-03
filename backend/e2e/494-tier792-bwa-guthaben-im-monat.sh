#!/bin/bash
# Tier 792 — a customer credit is in the BWA's month column of the month it was booked
#
# The BWA's line 1300 (Sonstige betriebliche Erträge: positive customer
# credits) dated every credit `new Date()` for its month column. Measured: the
# month column held all of the year's credits when the month asked for was the
# current one, and none for any other month — a credit of 15 March was not in
# March. Found by the run of the suite on New Year's night (Tier 792), where
# spec 112's identity left 1300 out (it holds now, with 1300).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-494-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
st=$(curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier792-e2e\",\"companyName\":\"$TAG GmbH\"}")
U=$(python3 -c "import json;print(json.load(open('$D/out'))['user']['id'])"); C=$(python3 -c "import json;print(json.load(open('$D/out'))['user']['companyId'])")
assert_eq "fixture: a company" "$st" "201"
st=$(curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}")
K=$(python3 -c "import json;print(json.load(open('$D/out'))['id'])")
YEAR=$(( $(date +%Y) - 1 ))   # a past year: no month of it is the current one
q "insert into \"CustomerCreditTransaction\" (id, \"companyId\", \"customerId\", amount, \"balanceAfter\", type, description, \"createdById\", \"createdAt\") values
   (gen_random_uuid()::text,'$C','$K',80,80,'overpayment','$TAG Januar','$U','$YEAR-01-15 12:00'),
   (gen_random_uuid()::text,'$C','$K',40,120,'overpayment','$TAG März','$U','$YEAR-03-15 12:00')" >/dev/null
line() { # month → "monat/ytd" of bucket 1300
  curl -sS "$API/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=$1" -H "x-user-id: $U" -H "x-company-id: $C" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);l=next(l for l in d['lines'] if l['bucket']=='1300');print(f\"{l['monat']:g}/{l['ytd']:g}\")"
}
assert_eq "March: the March credit in the month, both in the year (was 0/120)" "$(line 3)" "40/120"
assert_eq "January: the January credit only (was 0/80)" "$(line 1)" "80/80"
assert_eq "February: nothing in the month" "$(line 2)" "0/80"

summary
