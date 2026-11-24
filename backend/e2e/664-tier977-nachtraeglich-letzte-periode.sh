#!/bin/bash
# Tier 977 — a template billed in arrears bills its last period
#
# Billed in arrears ('previous'), the run on the 1st bills the month before.
# The end date was compared with the run date, not with the period it bills:
# a monthly subscription for one month (start 1st, end the last day of that
# month) made its run on the 1st of the next month — past the end, so the run
# was skipped and the template switched off. The one month it covered was
# never billed; every template in arrears lost its last period that way.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-664-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier977-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
ITEMS='[{"description":"Wartung","quantity":1,"unit":"Monat","unitPrice":100,"vatRate":0.19}]'
read -r START END NEXT < <(python3 -c "
import datetime,calendar
d=datetime.date.today().replace(day=1)
e=d.replace(day=calendar.monthrange(d.year,d.month)[1])
n=e+datetime.timedelta(days=1)
print(d.isoformat(), e.isoformat(), n.isoformat())")

AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"servicePeriod\":\"previous\",\"startDate\":\"$START\",\"endDate\":\"$END\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
assert_eq "fixture: one month in arrears, $START–$END; the run on $NEXT" "$STATUS/$(P "d['nextRunAt'][:10]")" "201/$NEXT"
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "the run bills the month (was 400 — end date reached, switched off)" "$STATUS" "201"
assert_eq "…one invoice, for $START–$END" \
  "$(q "select count(*) || ' ' || min(\"servicePeriodStart\")::date || ' ' || min(\"servicePeriodEnd\")::date from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "1 $START $END"
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "the next run: nothing left to bill — 400, the end reached" "$STATUS/$(P "'Enddatum' in d['message']")" "400/True"
assert_eq "…switched off, still one invoice" \
  "$(q "select \"isActive\" from \"RecurringInvoice\" where id='$R'")/$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "f/1"

# Billed in advance, the end date counts as before: the run after it bills nothing.
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG V\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"servicePeriod\":\"current\",\"startDate\":\"$START\",\"endDate\":\"$END\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
q "update \"RecurringInvoice\" set \"nextRunAt\"='$NEXT' where id='$R'" >/dev/null
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "in advance, a run after the end: 400, no invoice" "$STATUS/$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "400/0"

summary
