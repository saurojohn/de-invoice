#!/bin/bash
# Tier 495 — e-mailing a draft issues it the regular way
#
# POST /invoices/:id/send-email wrote status 'sent' straight onto a draft.
# Measured before: that skipped Tier 494 (an invoice without the mandatory
# details went out by e-mail), Tier 472 (a final invoice e-mailed as a draft
# never booked the Proforma's advance — it stayed in Bilanz 4200 and the
# customer was told to pay the whole amount again), and a cancelled invoice
# could still be e-mailed to the customer.
#
# Now a draft is issued through updateStatus before the PDF is rendered (the
# same checks and bookings as the status button); a cancelled one is
# refused.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-281-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier495-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a freshly registered company (no address yet)" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { # type price
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"$1\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  json_field "$BODY" id
}
mail() { AS POST "/api/v1/invoices/$1/send-email?companyId=$C" "{\"createdById\":\"$U\"}"; }
mails() { q "select count(*) from \"EmailSend\" where \"invoiceId\"='$1'"; }

note "=== a draft without the mandatory details is not e-mailed ==="
I=$(inv INV 1000); mail "$I"
assert_eq "refused (was sent anyway)" "$STATUS" "400"
assert_eq "…naming the gaps" "$(P "'Anschrift Ihres Unternehmens' in d['message']")" "True"
assert_eq "…nothing went out" "$(mails "$I")" "0"
assert_eq "…and it stays a draft" "$(q "select status from \"Invoice\" where id='$I'")" "draft"

fixture_issuer "$C"
mail "$I"
assert_eq "with the details: sent" "$STATUS/$(q "select status from \"Invoice\" where id='$I'")/$(mails "$I")" "201/sent/1"

note "=== a final invoice e-mailed as a draft settles the advance ==="
PI=$(inv PI 1000)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-10-01","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" '{}'
FI=$(json_field "$BODY" id)
mail "$FI"
assert_eq "e-mailed" "$STATUS" "201"
assert_eq "the advance is booked against it (was not)" \
  "$(q "select coalesce(sum(amount),0)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$FI' and \"paymentMethod\"='Anzahlung'")" "1190.00"
assert_eq "…so it is paid, not open for 1 190 € again" "$(q "select status from \"Invoice\" where id='$FI'")" "paid"

note "=== a cancelled invoice is not e-mailed ==="
X=$(inv INV 100)
AS PUT "/api/v1/invoices/$X/status?companyId=$C" '{"status":"cancelled"}'
mail "$X"
assert_eq "refused (was sent)" "$STATUS" "400"
assert_eq "…nothing went out" "$(mails "$X")" "0"

summary
