#!/bin/bash
# Tier 515 — nothing has happened on a date in the future
#
# Tier 514 refused a customer payment dated after today. Measured before, the
# other dates still took 2030: an expense's payment date and its invoice date
# (cost and input tax in the EÜR / UStVA of 2030), a payment to the Finanzamt
# (on a return and "other"), and an invoice issued with a date in the future
# (§ 14 Abs. 4 Nr. 3 UStG: the Ausstellungsdatum is the day it is issued) —
# revenue and output tax in a period that has not begun.
#
# Now all of them are refused (400). A draft may carry a later date — it is
# issued on or after that day.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-300-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier515-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")
expense() { # invoiceDate paidAt-json
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Material\",\"invoiceDate\":\"$1\"$2,\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
}

note "=== an expense ==="
expense "$TOMORROW" ""
assert_eq "an invoice date tomorrow: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Zukunft' in d['message']")" "True"
expense "$TODAY" ",\"paidAt\":\"2030-01-01\""
assert_eq "paid in 2030: 400 (was 201)" "$STATUS" "400"
expense "$TODAY" ",\"paidAt\":\"$TODAY\""
assert_eq "today: recorded" "$STATUS" "201"
E=$(json_field "$BODY" id)
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" '{"paidAt":"2030-01-01"}'
assert_eq "editing its payment date to 2030: 400" "$STATUS" "400"
AS PUT "/api/v1/ustva/expenses/$E?companyId=$C" "{\"invoiceDate\":\"$TOMORROW\"}"
assert_eq "editing its invoice date to tomorrow: 400" "$STATUS" "400"

note "=== payments to the Finanzamt ==="
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"ustja","year":2025,"paidAt":"2030-01-01","amount":100}'
assert_eq "an 'other' payment in 2030: 400 (was 201)" "$STATUS" "400"
AS POST "/api/v1/ustva/payments?companyId=$C" "{\"kind\":\"ustja\",\"year\":2025,\"paidAt\":\"$TODAY\",\"amount\":100}"
assert_eq "today: recorded" "$STATUS" "201"

note "=== issuing an invoice ==="
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TOMORROW\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_eq "a draft dated tomorrow is fine" "$STATUS" "201"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "issuing it today: 400 (was 200)" "$STATUS" "400"
assert_eq "…and the message says what to do" "$(P "'an diesem Tag' in d['message']")" "True"
assert_eq "…it stays a draft" "$(q "select status from \"Invoice\" where id='$I'")" "draft"
# The day has come (the issue date of a draft is not editable — set here).
q "update \"Invoice\" set \"issueDate\"='$TODAY' where id='$I'" >/dev/null
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "dated today: issued" "$STATUS" "200"

summary
