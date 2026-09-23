#!/bin/bash
# Tier 430 — a customer's "paid" click is a report, not a booked payment
#
# Measured before, on a sent 1 190 € invoice:
#   the customer portal's "als bezahlt markieren" with amount 1 → the invoice
#   went to "paid" with a 1,00 € payment: a customer claiming 1 € closed a
#   1 190 € invoice, the dunning stopped, and UStVA, DATEV and the balance
#   sheet counted money that never arrived
#   the payment link's "bezahlt" button booked the full total — also on a
#   part-paid invoice — and set it to "paid" on the click alone
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-219-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier430-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { # method path body — no auth (portal / payment link)
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
state() { q "select i.status||'|'||coalesce((select string_agg(round(amount,2)::text,',' order by \"createdAt\") from \"Payment\" p where p.\"invoiceId\"=i.id),'-') from \"Invoice\" i where id='$1'"; }

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"}}"; K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"; }
A=$(inv)
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
TOKEN=$(python3 -c "
import sys,json,urllib.parse as u
d=json.loads(sys.argv[1]); url=d.get('url','')
print(u.parse_qs(u.urlparse(url).query).get('token',[''])[0] or d.get('token',''))" "$BODY")
[[ -n "$TOKEN" ]] && pass "fixture: a portal session" || fail "portal session: $BODY"

note "=== 1. the customer reports a payment in the portal ==="
PUB POST "/api/v1/customer-portal/invoice/$A/mark-paid?token=$TOKEN" '{"amount":1}'
assert_eq "accepted as a report" "$STATUS/$(P "d.get('reported')")" "201/True"
assert_eq "the invoice stays open, nothing booked (was: paid, 1,00 € payment)" "$(state "$A")" "sent|-"
PUB POST "/api/v1/customer-portal/invoice/$A/mark-paid?token=$TOKEN" '{"amount":5}'
assert_eq "a second click returns the open report" "$(q "select count(*)||':'||round(max(amount),2) from \"PaymentNotice\" where \"invoiceId\"='$A'")" "1:1.00"
PUB GET "/api/v1/customer-portal/invoices?token=$TOKEN"
assert_eq "the portal shows it as reported" "$(P "[i['paymentReported']['amount'] for i in d['invoices'] if i['id']=='$A'][0]")" "1"

note "=== 2. the company decides ==="
AS GET "/api/v1/invoices/$A/payment-notices?companyId=$C"
N=$(P "d[0]['id']")
assert_eq "one open report on the invoice" "$(P "[(x['status'], x['source']) for x in d]")" "[('open', 'customer-portal')]"
AS POST "/api/v1/invoices/$A/payment-notices/$N/dismiss?companyId=$C" '{}'
assert_eq "the 1 € never arrived: dismissed" "$STATUS/$(state "$A")" "201/sent|-"
PUB POST "/api/v1/customer-portal/invoice/$A/mark-paid?token=$TOKEN" '{"amount":5000}'
assert_eq "a report above the open amount is refused" "$STATUS" "400"
PUB POST "/api/v1/customer-portal/invoice/$A/mark-paid?token=$TOKEN" '{}'
N2=$(P "d['noticeId']")
assert_eq "without an amount, the open 1 190 is reported" "$(P "d['amount']")" "1190"
AS POST "/api/v1/invoices/$A/payment-notices/$N2/book?companyId=$C" '{"paymentDate":"2026-09-15"}'
assert_eq "booked once the money is there: a real payment, invoice paid" "$STATUS/$(state "$A")" "201/paid|1190.00"
assert_eq "…and the report points at it" "$(q "select status||':'||(\"paymentId\" is not null) from \"PaymentNotice\" where id='$N2'")" "booked:true"
AS POST "/api/v1/invoices/$A/payment-notices/$N2/book?companyId=$C" '{}'
assert_eq "a report is booked once" "$STATUS" "400"

note "=== 3. the payment link ==="
B=$(inv)
AS POST "/api/v1/invoices/$B/payments?companyId=$C" '{"amount":190,"paymentDate":"2026-09-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$B/generate-payment-link?companyId=$C" '{"origin":"http://localhost:3100"}'
LT=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d.get('token') or d.get('url','').rstrip('/').rsplit('/',1)[-1])" "$BODY")
PUB POST "/api/v1/portal/$LT/mark-paid" '{}'
assert_eq "reported, the open 1 000 (was: 1 190 booked on top of the 190, invoice paid)" \
  "$STATUS/$(P "d.get('amount')")/$(state "$B")" "201/1000/sent|190.00"

summary; exit $?
