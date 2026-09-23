#!/bin/bash
# Tier 429 — a Ratenplan is paid through its invoice
#
# Measured before, on a 1 190 € invoice with 190 € already paid:
#   the plan was split over the full 1 190 (2 × 595) — the paid 190 asked for again
#   paying both Raten "completed" the plan, but the invoice stayed "sent" with
#   only the 190 on it: the 1 190 paid through the plan reached no payment, so
#   no UStVA/DATEV/balance-sheet/ageing ever saw it
#   the plan's dunning pause covered the whole customer and never ended
#   an overdue invoice could not get a plan ("Status overdue, nicht sent")
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-218-$(date +%s%N | cut -c1-13)"
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier429-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
inv() { # issueDate dueDate → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"
}
A=$(inv 2026-09-01 2026-10-01)
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":190,"paymentDate":"2026-09-10","paymentMethod":"bank_transfer"}'

note "=== 1. the plan covers what is open ==="
AS POST "/api/v1/installment-plans/from-invoice?companyId=$C" "{\"invoiceId\":\"$A\",\"installmentCount\":2,\"firstDueDate\":\"$TOMORROW\"}"
assert_eq "plan created" "$STATUS" "201"
PLAN=$(json_field "$BODY" id)
assert_eq "1 000 in 2 × 500 (was 1 190 in 2 × 595)" "$(P "'%s %s' % (d['totalAmount'], [i['amount'] for i in d['installments']])")" "1000 ['500', '500']"
AS POST "/api/v1/installment-plans?companyId=$C" "{\"invoiceId\":\"$(inv 2026-09-02 2026-10-02)\",\"installmentCount\":2,\"totalAmount\":5000,\"firstDueDate\":\"$TOMORROW\"}"
assert_eq "a plan above the open amount is refused" "$STATUS" "400"
assert_eq "the dunning pause is on this invoice, not on the customer" \
  "$(q "select coalesce(\"invoiceId\",'-')||'/'||coalesce(\"customerId\",'-') from \"Mahnungspause\" where \"companyId\"='$C'")" "$A/-"

note "=== 2. paying a Rate pays the invoice ==="
I1=$(q "select id from \"Installment\" where \"planId\"='$PLAN' order by \"sequenceNumber\" limit 1")
AS POST "/api/v1/installment-plans/$PLAN/installments/$I1/pay?companyId=$C" '{"amount":500}'
assert_eq "Rate 1 accepted" "$STATUS" "201"
assert_eq "the invoice has the payment (was: only the 190)" "$(q "select round(sum(amount)) from \"Payment\" where \"invoiceId\"='$A'")" "690"
# The second Rate arrives through the bank import / a manual payment on the invoice.
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":500,"paymentDate":"2026-09-20","paymentMethod":"bank_transfer"}'
assert_eq "…a payment on the invoice settles Rate 2 (was: the Raten stayed open)" \
  "$(q "select string_agg(status, ',' order by \"sequenceNumber\") from \"Installment\" where \"planId\"='$PLAN'")" "paid,paid"
assert_eq "plan completed, invoice paid (was: plan completed, invoice sent)" \
  "$(q "select p.status||'/'||i.status from \"InstallmentPlan\" p join \"Invoice\" i on i.id=p.\"invoiceId\" where p.id='$PLAN'")" "completed/paid"
assert_eq "the plan's pause has ended (was: open-ended)" \
  "$(q "select count(*) from \"Mahnungspause\" where \"companyId\"='$C' and (\"pausedUntil\" is null or \"pausedUntil\" > now())")" "0"

note "=== 3. removing a payment reopens the Rate ==="
PAY=$(q "select id from \"Payment\" where \"invoiceId\"='$A' order by \"createdAt\" desc limit 1")
AS DELETE "/api/v1/invoices/$A/payments/$PAY?companyId=$C"
assert_eq "Rate 2 open again, plan active" \
  "$(q "select p.status||':'||string_agg(i.status, ',' order by i.\"sequenceNumber\") from \"InstallmentPlan\" p join \"Installment\" i on i.\"planId\"=p.id where p.id='$PLAN' group by p.status")" "active:paid,open"

note "=== 4. an overpaid Rate covers the next one ==="
AS POST "/api/v1/installment-plans/$PLAN/installments/$(q "select id from \"Installment\" where \"planId\"='$PLAN' and \"sequenceNumber\"=2")/pay?companyId=$C" '{"amount":500}'
assert_eq "plan completed again" "$(q "select status from \"InstallmentPlan\" where id='$PLAN'")" "completed"

note "=== 5. an overdue invoice can get a plan ==="
O=$(inv 2026-06-01 2026-07-01); q "update \"Invoice\" set status='overdue' where id='$O'" >/dev/null
AS GET "/api/v1/installment-plans/suggestion/$O?companyId=$C"
assert_eq "eligible (was: 'Status overdue, nicht sent')" "$(P "d['eligible']")" "True"

summary; exit $?
