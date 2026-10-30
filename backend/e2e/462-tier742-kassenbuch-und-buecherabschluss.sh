#!/bin/bash
# Tier 742 — closed books hold the cash book too
#
# Tier 609 says of closed books: nothing is written, changed or deleted. The
# cash book asked only for entries with VAT (assertPeriodOpen) and for a day
# closed (Tagesabschluss). Measured: an entry without VAT was added, changed
# and deleted in closed books with 200.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-462-$(date +%s%N | cut -c1-13)"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier742-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
entry() { # date amount
  local body="{\"businessDate\":\"$1\",\"type\":\"einnahme\",\"amount\":$2,\"description\":\"Bar\"}"
  AS POST "/api/v1/cashbook/entries?companyId=$C" "$body"
}
entry 2026-09-10 100
assert_eq "fixture: an entry without VAT, books open" "$STATUS" "201"
ID=$(json_field "$BODY" id)
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-09-30","reason":"Spec 462"}'
assert_eq "fixture: the books closed up to 30.09." "$STATUS" "200"

entry 2026-09-11 50
assert_eq "a new entry in closed books: 400 (was 201)" "$STATUS/$(P "'Kassenbuchung' in d['message']")" "400/True"
AS PUT "/api/v1/cashbook/entries/$ID?companyId=$C" '{"amount":50}'
assert_eq "changing one: 400 (was 200)" "$STATUS" "400"
AS DELETE "/api/v1/cashbook/entries/$ID?companyId=$C"
assert_eq "deleting one: 400 (was 200)" "$STATUS" "400"
AS POST "/api/v1/cashbook/entries/$ID/reverse?companyId=$C" '{"reason":"Falsch"}'
assert_eq "a Storno, dated on the entry's day: 400" "$STATUS" "400"
assert_eq "…the entry as it was" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "SELECT amount::numeric(12,2), (SELECT count(*) FROM \"CashBookEntry\" WHERE \"companyId\"='$C') FROM \"CashBookEntry\" WHERE id='$ID';")" "100.00|1"

entry 2026-10-05 30
assert_eq "after the closed period: as ever" "$STATUS" "201"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":null,"reason":"Korrektur"}'
assert_eq "the closing lifted, with a reason" "$STATUS" "200"
AS PUT "/api/v1/cashbook/entries/$ID?companyId=$C" '{"amount":50}'
assert_eq "the entry can be changed again" "$STATUS" "200"

summary
