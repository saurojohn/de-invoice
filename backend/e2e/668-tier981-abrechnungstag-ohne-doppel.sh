#!/bin/bash
# Tier 981 — a new billing day continues after what was billed
#
# Changing the billing day (or the start, the interval, the service period)
# recomputed the next run from the start date and today only. Measured: a
# monthly template billed in advance on the 24th billed 24.11.–23.12.; the
# billing day set to the 1st made the next run 01.12. for 01.12.–31.12. —
# 23 days on two invoices (§ 14c Abs. 1 UStG: the second invoice's VAT owed).
# Switched from in advance to in arrears, the next run billed the month just
# billed in advance once more.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-668-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier981-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
ITEMS='[{"description":"Wartung","quantity":1,"unit":"Monat","unitPrice":310,"vatRate":0.19}]'
TODAY=$(TZ=Europe/Berlin date +%F)
DAY=$((10#${TODAY:8:2})); NEWDAY=$(( DAY == 1 ? 2 : 1 ))
# no overlap: every invoice's period starts after the one before ended
overlaps() {
  q "select count(*) from \"Invoice\" a join \"Invoice\" b on a.\"recurringInvoiceId\" = b.\"recurringInvoiceId\" and a.id < b.id
     and a.\"servicePeriodStart\" <= b.\"servicePeriodEnd\" and b.\"servicePeriodStart\" <= a.\"servicePeriodEnd\" where a.\"recurringInvoiceId\" = '$R'"
}
run() { AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'; }

note "=== in advance, the billing day moved ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"dayOfMonth\":$DAY,\"servicePeriod\":\"current\",\"startDate\":\"$TODAY\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
run
assert_eq "fixture: the first month billed from today" "$STATUS/$(q "select min(\"servicePeriodStart\")::date from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "201/$TODAY"
FIRST_END=$(q "select max(\"servicePeriodEnd\")::date from \"Invoice\" where \"recurringInvoiceId\"='$R'")
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" "{\"dayOfMonth\":$NEWDAY}"
assert_eq "the billing day set to the $NEWDAY.: saved" "$STATUS" "200"
NEXT=$(P "d['nextRunAt'][:10]")
GAP_FROM=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=1))" "$FIRST_END")
assert_eq "…the answer names the days the new schedule leaves out, from $GAP_FROM, and the next run" \
  "$(P "(d.get('unbilled') or {}).get('from')")/$(P "(d.get('unbilled') or {}).get('firstRun')")" "$GAP_FROM/$NEXT"
run
assert_eq "the next run bills after $FIRST_END — no day twice (was: the month again from the $NEWDAY.)" "$(overlaps)" "0"
assert_eq "…its period starts after the first ended" "$(q "select max(\"servicePeriodStart\")::date > '$FIRST_END'::date from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "t"

note "=== switched from in advance to in arrears ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG 2\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"dayOfMonth\":$DAY,\"servicePeriod\":\"current\",\"startDate\":\"$TODAY\",\"items\":$ITEMS}"
R=$(json_field "$BODY" id)
run
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"servicePeriod":"previous"}'
run
assert_eq "fixture: the second run made an invoice" "$STATUS/$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$R'")" "201/2"
assert_eq "the next run does not bill the month billed in advance again" "$(overlaps)" "0"

summary
