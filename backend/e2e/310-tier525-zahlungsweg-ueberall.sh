#!/bin/bash
# Tier 525 — the reserved payment methods are reserved on every route
#
# Tier 514 refused 'Gutschrift' and 'Guthaben' on POST /invoices/:id/payments
# — methods the system books itself and the reports read as "no money
# arrived". Measured afterwards, three other routes where a person names the
# method still took them: the customer's "Zahlung verteilen" (201 — an invoice
# paid by a "Gutschrift" with no credit note, and the rest booked as the
# customer's credit), a Rate of a Ratenplan, and booking a Zahlungsmeldung.
#
# Now all of them refuse the two (400), nothing is booked.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-310-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier525-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(date +%Y-%m-%d)
DUE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k-$TAG@example.test\"}}"
K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
booked() { q "select count(*) from \"Payment\" p join \"Invoice\" i on i.id=p.\"invoiceId\" where i.\"companyId\"='$C'"; }
credit() { AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"; P "d['balance']"; }

note "=== Zahlung verteilen ==="
inv
for M in Gutschrift Guthaben; do
  AS POST "/api/v1/customers/$K/allocate-payment?companyId=$C" "{\"amount\":2000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"$M\"}"
  assert_eq "$M: 400 (was 201)" "$STATUS" "400"
  assert_eq "…says where it is booked" "$(P "'nicht von Hand' in d['message']")" "True"
done
assert_eq "…nothing booked, no credit, the invoice open" "$(booked)/$(credit)/$(q "select status from \"Invoice\" where id='$I'")" "0/0/sent"

note "=== a Rate of a Ratenplan ==="
AS POST "/api/v1/installment-plans?companyId=$C" "{\"invoiceId\":\"$I\",\"installmentCount\":2,\"totalAmount\":1190,\"firstDueDate\":\"$DUE\",\"intervalDays\":30}"
PL=$(json_field "$BODY" id)
R=$(q "select id from \"Installment\" where \"planId\"='$PL' and \"sequenceNumber\"=1")
AS POST "/api/v1/installment-plans/$PL/installments/$R/pay?companyId=$C" "{\"amount\":595,\"paidAt\":\"$TODAY\",\"paymentMethod\":\"Gutschrift\"}"
assert_eq "Gutschrift: 400 (was 201)" "$STATUS" "400"
assert_eq "…the Rate is open, nothing booked" "$(q "select status from \"Installment\" where id='$R'")/$(booked)" "open/0"
AS POST "/api/v1/installment-plans/$PL/installments/$R/pay?companyId=$C" "{\"amount\":595,\"paidAt\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "by bank transfer: booked" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS")/$(booked)" "ok/1"

note "=== a Zahlungsmeldung ==="
inv
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
TOKEN=$(python3 -c "
import sys,json,urllib.parse as u
d=json.loads(sys.argv[1]); url=d.get('url','')
print(u.parse_qs(u.urlparse(url).query).get('token',[''])[0] or d.get('token',''))" "$BODY")
PUB POST "/api/v1/customer-portal/invoice/$I/mark-paid?token=$TOKEN" '{"amount":1190}'
N=$(q "select id from \"PaymentNotice\" where \"invoiceId\"='$I'")
[[ -n "$N" ]] && pass "fixture: the customer reported a payment" || fail "no notice: $BODY"
AS POST "/api/v1/invoices/$I/payment-notices/$N/book?companyId=$C" '{"paymentMethod":"Guthaben"}'
assert_eq "booked as Guthaben: 400 (was 201)" "$STATUS" "400"
assert_eq "…the report stays open, the invoice too" "$(q "select status from \"PaymentNotice\" where id='$N'")/$(q "select status from \"Invoice\" where id='$I'")" "open/sent"
AS POST "/api/v1/invoices/$I/payment-notices/$N/book?companyId=$C" '{}'
assert_eq "booked as a bank transfer: paid" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS")/$(q "select status from \"Invoice\" where id='$I'")" "ok/paid"

note "=== the invoice's own route (Tier 514) and the system's bookings ==="
inv
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":10,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"Gutschrift\"}"
assert_eq "POST payments, Gutschrift: still 400" "$STATUS" "400"
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "a credit note still settles its invoice" "$STATUS/$(q "select count(*) from \"Payment\" where \"invoiceId\"='$I' and \"paymentMethod\"='Gutschrift'")" "201/1"

summary
