#!/bin/bash
# Tier 500 — an invoice under an installment plan is not dunned
#
# A Ratenplan is a Stundung: the customer pays in installments, and while
# none of them is late they are not in Verzug (§ 286 BGB) for the invoice.
# Measured before: an invoice past its due date with an active plan whose
# first installment was due tomorrow was still listed as overdue
# (GET /reminders/overdue), a reminder for the full amount could be sent
# (POST /reminders/send 201), and the bulk run sent one too.
#
# Now such an invoice is left out of the overdue list, a manual reminder is
# refused (400) and the bulk run leaves it out — until an installment itself is
# overdue: then the plan is broken and the invoice is dunned again.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-286-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier500-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
MAIL="kunde-$TAG@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"$MAIL\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
overdue_invoice() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-31\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":2000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  q "update \"Invoice\" set \"dueDate\"='2026-08-31' where id='$id'" >/dev/null
  echo "$id"
}
listed() { AS GET "/api/v1/reminders/overdue?companyId=$C"; P "sum(1 for i in (d if isinstance(d, list) else d.get('invoices', [])) if i['id']=='$1')"; }
send() { AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$1\",\"recipientEmail\":\"$MAIL\",\"level\":\"first\",\"createdById\":\"$U\"}"; }
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")

PLAIN=$(overdue_invoice)
PLANNED=$(overdue_invoice)
AS POST "/api/v1/installment-plans/from-invoice?companyId=$C" "{\"invoiceId\":\"$PLANNED\",\"installmentCount\":2,\"firstDueDate\":\"$TOMORROW\"}"
PLAN=$(json_field "$BODY" id)
[[ -n "$PLAN" ]] && pass "fixture: an overdue invoice with a plan, first installment due tomorrow" || fail "plan: $BODY"

note "=== while the plan is kept ==="
assert_eq "the invoice without a plan is overdue" "$(listed "$PLAIN")" "1"
assert_eq "the one under the plan is not listed (was)" "$(listed "$PLANNED")" "0"
send "$PLANNED"
assert_eq "a manual reminder is refused (was 201)" "$STATUS" "400"
assert_eq "…saying why" "$(P "'Ratenplan' in d.get('message', '')")" "True"
AS POST "/api/v1/reminders/bulk-send" "{\"companyId\":\"$C\",\"invoiceIds\":[\"$PLANNED\",\"$PLAIN\"],\"level\":\"first\",\"createdById\":\"$U\"}"
assert_eq "the bulk run leaves it out (saying why) and dunns the other" \
  "$(P "sorted((r['invoiceId'], r['status'], 'Ratenplan' in (r.get('error') or '')) for r in d['results'])" | tr -d "'" )" \
  "$(python3 -c "print(sorted([('$PLANNED','failed',True),('$PLAIN','sent',False)]))" | tr -d "'")"
assert_eq "…no Mahnung on the planned invoice" "$(q "select count(*) from \"Mahnung\" where \"invoiceId\"='$PLANNED'")" "0"

note "=== an installment overdue: the plan is broken ==="
q "update \"Installment\" set \"dueDate\"='2026-09-15' where \"planId\"='$PLAN' and \"sequenceNumber\"=1" >/dev/null
assert_eq "listed again" "$(listed "$PLANNED")" "1"
send "$PLANNED"
assert_eq "a reminder goes out" "$STATUS" "201"

summary
