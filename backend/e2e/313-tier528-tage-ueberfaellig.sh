#!/bin/bash
# Tier 528 — one count of the days an invoice is overdue
#
# Measured before (the backend runs with TZ=Europe/Berlin, as in production):
# an invoice due 40 days ago stood in the dunning list with 39 days, its
# Mahnung was stored and printed with 39 days — the fee preview said 40. Due
# yesterday was "0 days overdue". The list and the send subtracted the due
# date (midnight UTC) from the server's local midnight, which is the evening
# before in UTC.
#
# Now every place counts calendar days in Germany: 40, and 1 for yesterday.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-313-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier528-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
# Days in Germany — the spec may run on a host with another time zone.
day() { TZ=Europe/Berlin python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=$1)).isoformat())"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k-$TAG@example.test\"}}"
K=$(json_field "$BODY" id)
inv() { # issueDate dueDate → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
listed() { AS GET "/api/v1/reminders/overdue?companyId=$C"; P "[i['daysOverdue'] for i in d if i['id']=='$I']"; }

note "=== due 40 days ago ==="
inv "$(day -60)" "$(day -40)"
assert_eq "the dunning list: 40 days (was 39)" "$(listed)" "[40]"
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=first"
assert_eq "the fee preview: 40 days" "$(P "d['daysOverdue']")" "40"
AS GET "/api/v1/reminders/$I/email-data?companyId=$C&level=first"
assert_eq "the letter's text: 40 days" "$(echo "$BODY" | grep -c "40 Tag")/$(echo "$BODY" | grep -c "39 Tag")" "1/0"
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"first\"}"
assert_eq "the Mahnung is sent" "$STATUS" "201"
assert_eq "…and stored with 40 days (was 39)" "$(q "select \"daysOverdue\" from \"Mahnung\" where \"invoiceId\"='$I'")" "40"

note "=== due yesterday, due today ==="
inv "$(day -20)" "$(day -1)"
assert_eq "due yesterday: listed with 1 day (was 0)" "$(listed)" "[1]"
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"first\"}"
assert_eq "…its Mahnung says 1 day (was 0)" "$STATUS/$(q "select \"daysOverdue\" from \"Mahnung\" where \"invoiceId\"='$I'")" "201/1"
inv "$(day -20)" "$(day 0)"
assert_eq "due today: not in the list" "$(listed)" "[]"

summary
