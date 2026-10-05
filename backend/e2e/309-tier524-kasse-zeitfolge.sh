#!/bin/bash
# Tier 524 — the Kassenbuch is kept in order of time
#
# Measured before: 16.09. closed with an Endbestand of 170 € — then a receipt
# of 5 € booked on the 12.09. (an open, earlier day): 201, and the closed day
# opened and ended at 175 €, not what its signed Tagesabschluss says. And
# receipts were booked on days before the Anfangsbestand's day, which is the
# cash the book began with.
#
# Now: nothing is booked, changed or deleted before a closed day (book on the
# first open day, or reopen the closes); nothing before the Anfangsbestand,
# and the Anfangsbestand not after existing entries. A Storno of an earlier
# entry stays possible and marks every later close as amended.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-309-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() {
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier524-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
e() { AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$1\",\"type\":\"$2\",\"description\":\"$TAG\",\"amount\":$3}"; }
day() { AS GET "/api/v1/cashbook/day?companyId=$C&date=$1"; P "str(d['anfang'])+'/'+str(d['ende'])"; }
company A
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }

note "=== before the Anfangsbestand ==="
e 2026-09-10 eroeffnung 100
assert_eq "the book begins on 10.09. with 100 €" "$STATUS" "201"
e 2026-09-01 einnahme 20
assert_eq "a receipt on 01.09.: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying when the book begins" "$(P "'10.09.2026' in d['message']")" "True"
e 2026-09-10 einnahme 50
assert_eq "a receipt on the first day: booked" "$STATUS" "201"

note "=== before a closed day ==="
e 2026-09-12 einnahme 10; E12=$(json_field "$BODY" id)
e 2026-09-16 ausgabe 30
assert_eq "16.09. opens with 160 € and ends with 130 €" "$(day 2026-09-16)" "160/130"
AS POST "/api/v1/cashbook/close-day?companyId=$C" '{"date":"2026-09-16","physicalCount":130}'
assert_eq "16.09. closed at 130 €" "$STATUS" "201"
e 2026-09-12 einnahme 5
assert_eq "a receipt on 12.09. after that: 400 (was 201)" "$STATUS" "400"
assert_eq "…naming the closed day" "$(P "'16.09.2026' in d['message']")" "True"
AS PUT "/api/v1/cashbook/entries/$E12?companyId=$C" '{"amount":99}'
assert_eq "changing the entry of 12.09.: 400 (was 200)" "$STATUS" "400"
AS DELETE "/api/v1/cashbook/entries/$E12?companyId=$C"
assert_eq "deleting it: 400 (was 200)" "$STATUS" "400"
assert_eq "the closed day is what was signed (was 165/135)" "$(day 2026-09-16)" "160/130"
e 2026-09-17 einnahme 5
assert_eq "the forgotten receipt on the next open day: booked" "$STATUS" "201"

note "=== a Storno of an earlier entry ==="
AS POST "/api/v1/cashbook/entries/$E12/reverse?companyId=$C" '{"reason":"falsch gebucht"}'
assert_eq "the Storno is booked" "$STATUS" "201"
assert_eq "…and the later close is marked as amended" "$(q "select \"amendedAt\" is not null from \"CashBookDailyClose\" where \"companyId\"='$C'")" "t"

note "=== reopened ==="
AS POST "/api/v1/cashbook/reopen-day?companyId=$C" '{"date":"2026-09-16"}'
e 2026-09-13 einnahme 5
assert_eq "16.09. reopened: 13.09. can be booked" "$STATUS" "201"

note "=== the Anfangsbestand after entries ==="
company B
e 2026-09-05 einnahme 40
assert_eq "B: a receipt without an Anfangsbestand" "$STATUS" "201"
e 2026-09-20 eroeffnung 100
assert_eq "B: an Anfangsbestand on 20.09., after it: 400 (was 201)" "$STATUS" "400"
e 2026-09-05 eroeffnung 100
assert_eq "B: on the first day: booked" "$STATUS" "201"

summary
