#!/bin/bash
# Tier 522 — a new Ratenplan after the old one; none on a draft
#
# Measured before: an invoice whose Ratenplan had been cancelled (the customer
# stopped paying, a new agreement was made) could never get another — "Für
# diese Rechnung existiert bereits ein Ratenplan", for good (`invoiceId` was
# unique). The same after a plan over a part of the invoice was completed.
# And a plan could be laid on a draft — an agreement about a claim that does
# not exist yet.
#
# Now: one *running* plan per invoice; a cancelled or completed one can be
# followed by a new one over what is still open; a draft is refused.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-307-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier522-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
DUE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; I=$(json_field "$BODY" id); }
issue() { AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
plan() { AS POST "/api/v1/installment-plans?companyId=$C" "{\"invoiceId\":\"$I\",\"installmentCount\":$1,\"totalAmount\":$2,\"firstDueDate\":\"$DUE\",\"intervalDays\":30}"; }
plans() { q "select coalesce(string_agg(status, ',' order by \"createdAt\"),'') from \"InstallmentPlan\" where \"invoiceId\"='$I'"; }

note "=== a draft ==="
inv
plan 3 1190
assert_eq "a plan on a draft: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Entwurf' in d['message']")" "True"
assert_eq "…no plan" "$(plans)" ""

note "=== cancelled, then a new agreement ==="
issue
plan 3 1190
assert_eq "a plan over 3 Raten" "$STATUS" "201"
PL1=$(json_field "$BODY" id)
plan 2 1190
assert_eq "a second one while it runs: 400" "$STATUS" "400"
assert_eq "…it says a plan is running" "$(P "'läuft bereits' in d['message']")" "True"
# The first Rate is paid, then the customer stops and the plan is cancelled.
R1=$(q "select id from \"Installment\" where \"planId\"='$PL1' and \"sequenceNumber\"=1")
AS POST "/api/v1/installment-plans/$PL1/installments/$R1/pay?companyId=$C" "{\"amount\":396.67,\"paidAt\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the first Rate is paid" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS $BODY")" "ok"
AS DELETE "/api/v1/installment-plans/$PL1?companyId=$C"
assert_eq "the plan is cancelled" "$STATUS/$(plans)" "200/cancelled"
plan 2 1190
assert_eq "a new plan over the full total: 400 (793,33 are open)" "$STATUS" "400"
plan 2 793.33
assert_eq "a new plan over what is open: 201 (was 400, for good)" "$STATUS" "201"
PL2=$(json_field "$BODY" id)
assert_eq "…the old one stays, cancelled" "$(plans)" "cancelled,active"
assert_eq "…the old one keeps its paid Rate" "$(q "select string_agg(status, ',' order by \"sequenceNumber\") from \"Installment\" where \"planId\"='$PL1'")" "paid,cancelled,cancelled"
AS GET "/api/v1/installment-plans/by-invoice/$I?companyId=$C"
assert_eq "the invoice shows the running plan" "$(P "d['id']")" "$PL2"
AS GET "/api/v1/installment-plans/suggestion/$I?companyId=$C"
assert_eq "no suggestion while one runs" "$(P "d['eligible']")" "False"

note "=== the new plan is paid ==="
for n in 1 2; do
  R=$(q "select id from \"Installment\" where \"planId\"='$PL2' and \"sequenceNumber\"=$n")
  A=$(q "select amount from \"Installment\" where id='$R'")
  AS POST "/api/v1/installment-plans/$PL2/installments/$R/pay?companyId=$C" "{\"amount\":$A,\"paidAt\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
done
assert_eq "both Raten paid: the plan completed, the invoice paid" "$(plans)/$(q "select status from \"Invoice\" where id='$I'")" "cancelled,completed/paid"
assert_eq "…three payments, 1 190 € in all" "$(q "select count(*)||'/'||sum(amount)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$I'")" "3/1190.00"

note "=== a plan over a part, completed, then one over the rest ==="
inv; issue
plan 2 400
assert_eq "a plan over 400 of 1 190" "$STATUS" "201"
PL3=$(json_field "$BODY" id)
for n in 1 2; do
  R=$(q "select id from \"Installment\" where \"planId\"='$PL3' and \"sequenceNumber\"=$n")
  AS POST "/api/v1/installment-plans/$PL3/installments/$R/pay?companyId=$C" "{\"amount\":200,\"paidAt\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
done
assert_eq "it is completed, the invoice still open" "$(plans)/$(q "select status from \"Invoice\" where id='$I'")" "completed/sent"
plan 2 790
assert_eq "a plan over the remaining 790: 201 (was 400)" "$STATUS" "201"

summary
