#!/bin/bash
# Tier 519 — a paused subscription is not billed for the pause afterwards
#
# Measured before: a monthly template whose next run was 01.06., paused until
# 30.09. — after the pause the next invoice was June's, then July's, August's
# and September's, one each morning (the pause never moved `nextRunAt`). The
# same after switching a template off for months and on again. And setting
# the pause with a date ("2026-09-30", valid for the DTO) answered 500.
#
# Now the periods of a pause (or of the time a template was off) are skipped:
# the next run is the first date after the pause / from today on.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-304-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier519-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
tpl() { # name startDate → R
  AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG $1\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"$2\",\"servicePeriod\":\"current\",\"items\":$ITEMS}"
  R=$(json_field "$BODY" id)
  # Tier 535: a new template starts from today. These have existed since
  # 2024 — their next run is written to the row.
  [[ "$2" == "2024-05-01" ]] && q "update \"RecurringInvoice\" set \"nextRunAt\"='2024-06-01' where id='$R'" >/dev/null
  return 0
}
next() { q "select \"nextRunAt\"::date from \"RecurringInvoice\" where id='$R'"; }
invoices() { q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'"; }
# The first of this month and of the next (the schedule is the 1st).
THIS=$(python3 -c "import datetime;print(datetime.date.today().replace(day=1).isoformat())")
NEXT=$(python3 -c "import datetime;d=datetime.date.today().replace(day=1);print((d.replace(year=d.year+1,month=1) if d.month==12 else d.replace(month=d.month+1)).isoformat())")
ISFIRST=$([[ "$(date +%d)" == "01" ]] && echo yes || echo no)
# From today on: today itself when today is the 1st.
FROMTODAY=$([[ "$ISFIRST" == yes ]] && echo "$THIS" || echo "$NEXT")

note "=== a pause that is over ==="
tpl "Pause" "2024-05-01"
assert_eq "fixture: the next run is 01.06.2024" "$(next)" "2024-06-01"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":"2024-09-30"}'
assert_eq "pausing with a date: 200 (was 500)" "$STATUS" "200"
assert_eq "…through that day in Germany (23:59:59 CEST)" "$(q "select \"pausedUntil\" from \"RecurringInvoice\" where id='$R'")" "2024-09-30 21:59:59.999"
AS GET "/api/v1/recurring-invoices/$R/preview?companyId=$C"
assert_eq "the preview shows October, not June" "$(P "d['periodStart'][:10]")" "2024-10-01"
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "the run bills October (was June)" "$(P "d['periodStart'][:10]")" "2024-10-01"
assert_eq "…its service period too" "$(q "select \"servicePeriodStart\"::date from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "2024-10-01"
assert_eq "…then November" "$(next)" "2024-11-01"
assert_eq "…one invoice, none for the pause" "$(invoices)" "1"

note "=== the scheduler, when the next date after the pause has not come ==="
tpl "Scheduler" "2024-05-01"
# Paused until yesterday: the periods up to then are skipped.
YESTERDAY=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=1)).isoformat())")
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" "{\"pausedUntil\":\"$YESTERDAY\"}"
AS POST "/api/v1/recurring-invoices/$R/_test/scheduled-run?companyId=$C" '{}'
if [[ "$ISFIRST" == yes ]]; then
  assert_eq "today is the 1st: the scheduler bills this month" "$(invoices)/$(next)" "1/$NEXT"
else
  assert_eq "the scheduler bills nothing (was: June 2024)" "$STATUS/$(invoices)" "400/0"
  assert_eq "…and waits for the next 1st" "$(next)" "$NEXT"
fi

note "=== switched off and on again ==="
tpl "Aus" "2024-05-01"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"isActive":false}'
assert_eq "switched off: the date stays" "$(next)" "2024-06-01"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"isActive":true}'
assert_eq "switched on: the next run is from today on (was 01.06.2024)" "$(next)" "$FROMTODAY"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"name":"umbenannt"}'
assert_eq "an edit of an active template leaves the date" "$(next)" "$FROMTODAY"

note "=== a running pause lifted early ==="
tpl "Früher" "2024-05-01"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":"2099-12-31T00:00:00.000Z"}'
assert_eq "paused until 2099" "$STATUS" "200"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"pausedUntil":null}'
assert_eq "lifted: the next run is from today on" "$(next)" "$FROMTODAY"

note "=== no pause: a missed run is still made up ==="
tpl "Ohne" "2024-05-01"
AS POST "/api/v1/recurring-invoices/$R/_test/scheduled-run?companyId=$C" '{}'
assert_eq "the scheduler bills the due period" "$(P "d['periodStart'][:10]")" "2024-06-01"

summary
