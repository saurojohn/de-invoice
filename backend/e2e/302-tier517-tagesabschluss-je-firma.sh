#!/bin/bash
# Tier 517 — the Tagesabschluss belongs to one company
#
# Found by spec 301 on a database other specs had used: closing today's
# Kassenbuch answered 500. `CashBookDailyClose.businessDate` was unique on its
# own — across all companies. Once any company had closed a day, no other
# company could close that day (P2002 → 500); the service itself looks the
# close up per company and found none.
#
# Now the key is (companyId, businessDate): each company closes its own day,
# and a second close of the same day by the same company stays a 400.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-302-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
TODAY=$(date +%Y-%m-%d)
# A day of the spec's own, so that no other spec's close decides the outcome.
DAY=$(python3 -c "import datetime,random;print((datetime.date(2015,1,1)+datetime.timedelta(days=random.randrange(0,1800))).isoformat())")
while [[ "$(q "select count(*) from \"CashBookDailyClose\" where \"businessDate\"='$DAY'")" != "0" ]]; do
  DAY=$(python3 -c "import datetime,random;print((datetime.date(2015,1,1)+datetime.timedelta(days=random.randrange(0,1800))).isoformat())")
done

company() { # suffix → sets U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier517-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
book() { AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$DAY\",\"type\":\"eroeffnung\",\"description\":\"$TAG\",\"amount\":$1}"; }
close_day() { AS POST "/api/v1/cashbook/close-day?companyId=$C" "{\"date\":\"$DAY\",\"physicalCount\":$1}"; }

note "=== two companies close the same day ($DAY) ==="
company A; UA=$U; CA=$C
book 100; assert_eq "A books its opening balance" "$STATUS" "201"
close_day 100; assert_eq "A closes the day" "$STATUS" "201"
company B; UB=$U; CB=$C
book 250; assert_eq "B books its opening balance" "$STATUS" "201"
close_day 250
assert_eq "B closes the same day: 201 (was 500)" "$STATUS" "201"
assert_eq "…with its own balance" "$(python3 -c "import sys,json;print(float(json.loads(sys.argv[1])['endbestand']))" "$BODY" 2>/dev/null)" "250.0"
assert_eq "…one close each" "$(q "select count(*) from \"CashBookDailyClose\" where \"businessDate\"='$DAY' and \"companyId\" in ('$CA','$CB')")" "2"
AS GET "/api/v1/cashbook/close?companyId=$C&date=$DAY"
assert_eq "B reads its own close" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['companyId'])" "$BODY" 2>/dev/null)" "$CB"

note "=== the same company, the same day ==="
close_day 250
assert_eq "B closes it again: 400" "$STATUS" "400"
assert_eq "…still one close for B" "$(q "select count(*) from \"CashBookDailyClose\" where \"businessDate\"='$DAY' and \"companyId\"='$CB'")" "1"
assert_eq "the key is per company" "$(q "select count(*) from pg_indexes where tablename='CashBookDailyClose' and indexdef like '%UNIQUE%' and indexdef like '%\"companyId\", \"businessDate\"%'")" "1"

summary
