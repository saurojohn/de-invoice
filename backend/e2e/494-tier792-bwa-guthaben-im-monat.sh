#!/bin/bash
# Tier 792 — what the BWA's line 1300 holds is in the month column of its month
#
# The BWA's line 1300 (Sonstige betriebliche Erträge) dated every item `new
# Date()` for its month column. Measured: the month column held all of the
# year's items when the month asked for was the current one, and none for any
# other month — an item of 15 March was not in March. Found by the run of the
# suite on New Year's night (Tier 792), where spec 112's identity left 1300 out.
#
# Tier 852: the customer credits (an overpayment) this spec booked are no
# income any more — owed to the customer. They are still booked here and must
# stay out of 1300; the month placement is checked with manual vouchers of
# other income (account 2700), which 1300 holds.
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
curl -sS -o /dev/null -X POST "$API/api/v1/accounting/accounts/seed?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
curl -sS -o /dev/null -X POST "$API/api/v1/accounting/accounts?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d '{"accountNumber":"2700","name":"Sonstige Erträge","type":"revenue"}'
acct() { q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='$1'"; }
A1200=$(acct 1200); A2700=$(acct 2700)
voucher() { # day amount
  local b="{\"companyId\":\"$C\",\"date\":\"$1\",\"description\":\"Sonstiger Ertrag $TAG\",\"referenceType\":\"Manual\",\"status\":\"posted\",\"lines\":[{\"accountId\":\"$A1200\",\"debit\":$2,\"credit\":0},{\"accountId\":\"$A2700\",\"debit\":0,\"credit\":$2}]}"
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/accounting/vouchers" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$b"
}
assert_eq "fixture: other income of 80 € on 15 January and 40 € on 15 March (manual vouchers)" "$(voucher "$YEAR-01-15" 80)/$(voucher "$YEAR-03-15" 40)" "201/201"
line() { # month → "monat/ytd" of bucket 1300
  curl -sS "$API/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=$1" -H "x-user-id: $U" -H "x-company-id: $C" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);l=next(l for l in d['lines'] if l['bucket']=='1300');print(f\"{l['monat']:g}/{l['ytd']:g}\")"
}
assert_eq "March: the March income in the month, both in the year (was 0/120); the credits not (Tier 852)" "$(line 3)" "40/120"
assert_eq "January: the January income only (was 0/80)" "$(line 1)" "80/80"
assert_eq "February: nothing in the month" "$(line 2)" "0/80"

summary
