#!/bin/bash
# Tier 521 — a skipped run does not take the period it did not bill
#
# Measured before, a monthly template paused until 2099, "Jetzt generieren":
#   - 400 "End date reached; auto-disabled" — it is paused, not ended;
#   - a second click: 500 (the skipped run was stored under the period, and
#     (template, periodStart) is unique);
#   - the pause lifted, the period run: 400 "Already ran for period … (race)"
#     — the skipped row held the period, so it could never be billed; the
#     scheduler would have failed on it every morning.
#
# Now the skipped row records the moment of the skip, the message says what
# happened, and the period is billed once the pause is over.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-306-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier521-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
ITEMS='[{"description":"Abo","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
START=$(python3 -c "import datetime;print(datetime.date.today().replace(day=1).isoformat())")
NEXT=$(python3 -c "import datetime;d=datetime.date.today().replace(day=1);print((d.replace(year=d.year+1,month=1) if d.month==12 else d.replace(month=d.month+1)).isoformat())")
run() { AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'; }
runs() { q "select count(*) from \"RecurringRun\" where \"recurringInvoiceId\"='$R' and status='$1'"; }

note "=== a paused template, run by hand ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"$START\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
assert_eq "fixture: the next run is the 1st of next month" "$(P "d['nextRunAt'][:10]")" "$NEXT"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":"2099-01-01T00:00:00.000Z"}'
run
assert_eq "400" "$STATUS" "400"
assert_eq "…it says paused, and until when (was: End date reached)" "$(P "d['message']")" "Die Vorlage ist bis 01.01.2099 pausiert."
run
assert_eq "a second click: 400 (was 500)" "$STATUS" "400"
assert_eq "…two skipped runs, no invoice" "$(runs skipped)/$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "2/0"
assert_eq "…none of them holds the period" "$(q "select count(*) from \"RecurringRun\" where \"recurringInvoiceId\"='$R' and \"periodStart\"='$NEXT'")" "0"
assert_eq "…the template is still active" "$(q "select \"isActive\" from \"RecurringInvoice\" where id='$R'")" "t"

note "=== the pause is lifted ==="
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":null}'
run
assert_eq "the period is billed (was 400 Already ran … (race))" "$STATUS" "201"
assert_eq "…the period it was about" "$(P "d['periodStart'][:10]")" "$NEXT"
assert_eq "…one invoice" "$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "1"

note "=== a template past its end ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG Ende\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"2024-05-01\",\"endDate\":\"2024-05-15\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
run
assert_eq "400, saying it has ended" "$STATUS/$(P "'Enddatum' in d['message']")" "400/True"
assert_eq "…switched off, one skipped run" "$(q "select \"isActive\" from \"RecurringInvoice\" where id='$R'")/$(runs skipped)" "f/1"
# The end is moved out and the template switched on again: the next run is
# from today on (Tier 519) and can be billed.
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"endDate":"2099-12-31","isActive":true}'
run
assert_eq "extended and switched on: billed" "$STATUS" "201"

note "=== the scheduler counts a skip as skipped ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG Plan\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"2024-05-01\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":"2099-01-01T00:00:00.000Z"}'
AS POST "/api/v1/recurring-invoices/$R/_test/scheduled-run?companyId=$C" '{}'
assert_eq "paused, run as the scheduler does: 400, paused" "$STATUS/$(P "'pausiert' in d['message']")" "400/True"

summary
