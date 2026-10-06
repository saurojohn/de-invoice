#!/bin/bash
# Tier 535 — a template entered with a start in the past does not bill the time since
#
# Decided by the user (06.10.2026): "nicht nachberechnen, ab heute". Measured
# before: a monthly subscription that began on 01.01.2024, entered today — its
# next run was 01.02.2024, and the scheduler made one invoice each morning
# (February 2024, March 2024, …) until it had caught up, e-mailed to the
# customer if the template says so.
#
# Now the next run of a new template (created, cloned, or re-scheduled by an
# edit of its start / interval / day) is the first date of its schedule from
# today on. The first run stays one interval after the start (unchanged,
# decided the same day); a template that already exists keeps its date; a
# back period is billed with "Jetzt generieren".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-320-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier535-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
tpl() { # interval dayOfMonth startDate → R
  AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"$1\",\"dayOfMonth\":$2,\"startDate\":\"$3\",\"items\":$ITEMS}"
  R=$(json_field "$BODY" id)
}
next() { q "select \"nextRunAt\"::date from \"RecurringInvoice\" where id='$R'"; }
# In Germany, as the backend counts days.
py() { TZ=Europe/Berlin python3 -c "import datetime;t=datetime.date.today();$1"; }
TODAY=$(py "print(t.isoformat())")
# The first 1st of a month from today on.
FIRST1=$(py "print(t.isoformat() if t.day==1 else (t.replace(day=1,year=t.year+(t.month==12),month=t.month%12+1)).isoformat())")

note "=== monthly, begun in January 2024 ==="
tpl monthly 1 "2024-01-01"
assert_eq "created" "$STATUS" "201"
assert_eq "the next run is the first 1st from today on (was 01.02.2024)" "$(next)" "$FIRST1"
assert_eq "…never in the past" "$([[ "$(next)" < "$TODAY" ]] && echo past || echo ok)" "ok"
AS GET "/api/v1/recurring-invoices/$R/preview?companyId=$C"
assert_eq "the preview shows that period" "$(P "d['periodStart'][:10]")" "$FIRST1"

note "=== weekly and yearly ==="
tpl weekly 1 "2024-01-01"   # a Monday
W=$(next)
assert_eq "weekly since a Monday in 2024: a Monday, within a week from today" \
  "$(py "import sys;n=datetime.date.fromisoformat('$W');print(n.weekday(), 0 <= (n-t).days < 7)")" "0 True"
tpl yearly 1 "2020-03-15"
Y=$(next)
assert_eq "yearly since 15.03.2020: the next 15.03. from today on" \
  "$(py "n=datetime.date.fromisoformat('$Y');print(n.month, n.day, 0 <= (n-t).days <= 366)")" "3 15 True"

note "=== a start in the future is as before ==="
tpl monthly 1 "2031-05-01"
assert_eq "start 01.05.2031 → first run 01.06.2031" "$(next)" "2031-06-01"

note "=== an edit of the schedule ==="
tpl monthly 1 "2031-05-01"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"startDate":"2024-01-01"}'
assert_eq "the start moved to 2024: from today on (was 01.02.2024)" "$STATUS/$(next)" "200/$FIRST1"

note "=== a template that exists keeps its date; a back period by hand ==="
tpl monthly 1 "2031-05-01"
q "update \"RecurringInvoice\" set \"startDate\"='2024-01-01', \"nextRunAt\"='2024-02-01' where id='$R'" >/dev/null
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"name":"umbenannt"}'
assert_eq "renamed: its next run stays 01.02.2024" "$(next)" "2024-02-01"
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "\"Jetzt generieren\" bills the back period" "$STATUS/$(P "d['periodStart'][:10]")" "201/2024-02-01"

summary
