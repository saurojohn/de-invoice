#!/bin/bash
# Tier 600 — a recurring run that does not commit gives its number back
#
# The run takes the invoice number inside its transaction; a sequence does
# not roll back with it. A run that failed after that point — here: the run
# record of the period already exists, the database's last line of defence
# against a double run — left a hole in the series. (Tier 585 fixed the same
# for invoices created by hand and noted this one as not changed.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-359-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier600-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
numbers() { q "select coalesce(string_agg(\"sequenceNumber\"::text, ',' order by \"sequenceNumber\"), '-') from \"Invoice\" where \"companyId\"='$C' and type='INV'"; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
# monthly since four months ago: several periods are due
START=$(python3 -c "import datetime;d=datetime.date.today();m=d.month-4;y=d.year+(m-1)//12;print(datetime.date(y,(m-1)%12+1,1).isoformat())")
AS POST "/api/v1/recurring-invoices?companyId=$C" '{"name":"'$TAG' Abo","customerId":"'$K'","interval":"monthly","startDate":"'$START'","items":[{"description":"Wartung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
T=$(json_field "$BODY" id)
[[ -n "$T" ]] && pass "fixture: a monthly template since $START" || { fail "template: $STATUS $BODY"; summary; exit 1; }

note "=== 1. a run that commits ==="
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the first period is invoiced" "$([[ "$STATUS" =~ ^2 ]] && echo ok || echo "$STATUS $BODY" | cut -c1-120)/$(numbers)" "ok/1"

note "=== 2. a run that fails after it took its number ==="
# the run record of the NEXT period already exists (what a second server would have written)
NEXT=$(q "select \"nextRunAt\" from \"RecurringInvoice\" where id='$T'")
q "insert into \"RecurringRun\" (id, \"recurringInvoiceId\", \"companyId\", trigger, \"periodStart\", \"periodEnd\", status) select gen_random_uuid(), '$T', '$C', 'scheduled', \"nextRunAt\", \"nextRunAt\" + interval '1 month', 'success' from \"RecurringInvoice\" where id='$T'" >/dev/null
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the run is refused, no invoice is written" "$([[ "$STATUS" =~ ^4 ]] && echo refused || echo "$STATUS")/$(numbers)" "refused/1"
assert_eq "…and it says why" "$(echo "$BODY" | grep -c 'Already ran for period')" "1"

note "=== 3. the number it took is not lost ==="
q "delete from \"RecurringRun\" where \"recurringInvoiceId\"='$T' and \"invoiceId\" is null" >/dev/null
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the next run gets 000002 (was 000003 — the failed run had used up 000002)" "$([[ "$STATUS" =~ ^2 ]] && echo ok || echo "$STATUS")/$(numbers)" "ok/1,2"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$(date +%Y-%m-%d)'","items":[{"description":"x","quantity":1,"unit":"Stk","unitPrice":10,"vatRate":0.19}]}'
assert_eq "…and an invoice made by hand continues the series" "$(numbers)" "1,2,3"
summary
