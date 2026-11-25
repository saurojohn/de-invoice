#!/bin/bash
# Tier 998 — a business customer is in default 30 days after the due date, or by a reminder
#
# § 286 Abs. 3 Satz 1 BGB: without a reminder the debtor is in default 30
# days after the due date and receipt of the invoice; a due date the invoice
# sets on its own is no agreed calendar date (Abs. 2 Nr. 1). Interest was
# asked from the day after the due date. Where the contract agrees the date,
# the company says so in the dunning settings (`zahlungszielVereinbart`), and
# interest runs from the due date as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-685-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
ISS=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=130))" "$TODAY")
DUE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=100))" "$TODAY")
SENT=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=90))" "$TODAY")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier998-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$ISS\",\"deliveryDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
preview() { AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=second"; }
days_of() { P "round(d['verzugszins'] * 100 * 365 / (11900 * d['verzugszinsPct']))"; }   # the days the interest covers
preview
assert_eq "no reminder: interest from the 31st day after the due date — 70 days (was 100)" "$(days_of)" "70"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"zahlungszielVereinbart":true}'
assert_eq "the company: payment dates are agreed in its contracts" "$STATUS/$(P "d['config'].get('zahlungszielVereinbart')")" "200/True"
preview
assert_eq "…then from the day after the due date — 100 days" "$(days_of)" "100"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"zahlungszielVereinbart":false}'
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"first\"}"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "update \"Mahnung\" set \"sentAt\"='$SENT', \"createdAt\"='$SENT' where \"invoiceId\"='$I'" >/dev/null
preview
assert_eq "a reminder 10 days after the due date: interest from the day after it — 90 days" "$(days_of)" "90"

summary
