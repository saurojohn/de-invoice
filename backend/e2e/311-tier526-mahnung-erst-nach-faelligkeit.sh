#!/bin/bash
# Tier 526 — a Mahnung needs an overdue invoice, and the levels only go up
#
# Measured before: an invoice issued today and due in 30 days — "Mahnung
# senden": 201, a Zahlungserinnerung with a 5 € fee e-mailed to the customer
# (the cron looks at the due date; the invoice page's button and the bulk send
# took any open invoice). And on an overdue invoice: the "letzte Mahnung"
# first, then a "Zahlungserinnerung", then the "1. Mahnung" — all sent.
#
# Now: not before the day after the due date; after a higher level no lower
# one follows (a cancelled Mahnung does not count).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-311-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier526-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
day() { python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=$1)).isoformat())"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k-$TAG@example.test\"}}"
K=$(json_field "$BODY" id)
inv() { # issueDate dueDate → I (issued; an issue date in the past is set on the row)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
send() { AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"$1\"}"; }
mahnungen() { q "select coalesce(string_agg(level, ',' order by \"createdAt\"),'') from \"Mahnung\" where \"invoiceId\"='$I' and \"cancelledAt\" is null"; }

note "=== not yet due ==="
inv "$(day 0)" "$(day 30)"
send first
assert_eq "due in 30 days: 400 (was 201, with a fee)" "$STATUS" "400"
assert_eq "…saying it is not overdue" "$(P "'noch nicht überfällig' in d['message']")" "True"
assert_eq "…no Mahnung" "$(mahnungen)" ""
inv "$(day -14)" "$(day 0)"
send first
assert_eq "due today: 400 — the day is not over" "$STATUS" "400"
AS POST "/api/v1/reminders/bulk-send" "{\"companyId\":\"$C\",\"invoiceIds\":[\"$I\"],\"level\":\"first\"}"
assert_eq "the bulk send does not send it either" "$(mahnungen)/$(P "d['succeeded']")/$(P "'noch nicht überfällig' in d['results'][0]['error']")" "/0/True"

note "=== overdue ==="
inv "$(day -30)" "$(day -1)"
send first
assert_eq "due yesterday: sent" "$STATUS" "201"
inv "$(day -60)" "$(day -40)"
send final
assert_eq "40 days overdue, the letzte Mahnung at once: sent" "$STATUS" "201"
send first
assert_eq "a Zahlungserinnerung after it: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying which level went out" "$(P "'Letzte Mahnung' in d['message']")" "True"
send second
assert_eq "the 1. Mahnung after it: 400 (was 201)" "$STATUS" "400"
assert_eq "…one Mahnung on the invoice" "$(mahnungen)" "final"

note "=== a cancelled Mahnung does not count ==="
M=$(q "select id from \"Mahnung\" where \"invoiceId\"='$I'")
AS POST "/api/v1/reminders/mahnungen/$M/cancel?companyId=$C" '{"reason":"falsche Stufe"}'
assert_eq "the letzte Mahnung is cancelled" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS $BODY")" "ok"
send first
assert_eq "now the Zahlungserinnerung goes out" "$STATUS/$(mahnungen)" "201/first"
send second
assert_eq "…and the 1. Mahnung after it" "$STATUS/$(mahnungen)" "201/first,second"

summary
