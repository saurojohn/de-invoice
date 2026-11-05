#!/bin/bash
# Tier 800 — a template billed in advance makes its first invoice on its start
#
# The first run was always one interval after the start (decided 06.10.2026,
# Tier 535). For a template billed in advance („im Voraus", the form's
# default) that skipped the first period: measured on a clock at 31.12.2026,
# a monthly template starting 01.01.2027 had its first run on 01.02.2027,
# billing February, and January was billed by no invoice. The owner,
# 05.11.2026: „预收时第一张开在开始日".
#
# Billed in advance, the first run is the first date of the schedule on or
# after the start. In arrears and without a service period it stays one
# interval after the start. Start dates in 2031 keep "from today on"
# (Tier 535) out of the way; one case starts today.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-499-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier799-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
ITEMS='[{"description":"Wartung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
tpl() { # interval dayOfMonth startDate servicePeriod → R
  local body="{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"$1\",\"dayOfMonth\":$2,\"startDate\":\"$3\",\"servicePeriod\":\"$4\",\"items\":$ITEMS,\"sendEmail\":false}"
  AS POST "/api/v1/recurring-invoices?companyId=$C" "$body"
  R=$(json_field "$BODY" id)
}
next() { q "select to_char(\"nextRunAt\", 'YYYY-MM-DD') from \"RecurringInvoice\" where id='$R'"; }

note "=== billed in advance: the first run is the start ==="
tpl monthly 1 "2031-05-01" current
assert_eq "monthly from 01.05.2031: first run 01.05.2031 (was 01.06.2031, May unbilled)" "$STATUS/$(next)" "201/2031-05-01"
FIRST=$R
tpl monthly 15 "2031-05-10" current
assert_eq "on the 15th, from 10.05.: 15.05. (was 15.06.)" "$(next)" "2031-05-15"
tpl monthly 15 "2031-05-20" current
assert_eq "on the 15th, from 20.05.: the 15th has passed, 15.06." "$(next)" "2031-06-15"
tpl monthly 31 "2031-02-01" current
assert_eq "on the 31st, from 01.02.: February's last day, 28.02." "$(next)" "2031-02-28"
tpl quarterly 1 "2031-04-01" current
assert_eq "quarterly from 01.04.2031: 01.04.2031 (was 01.07.)" "$(next)" "2031-04-01"
tpl weekly 1 "2031-05-05" current
assert_eq "weekly from Monday 05.05.2031: that Monday (was 12.05.)" "$(next)" "2031-05-05"
tpl yearly 1 "2031-03-15" current
assert_eq "yearly from 15.03.2031: 15.03.2031 (was 15.03.2032)" "$(next)" "2031-03-15"

note "=== in arrears and without a period: as decided on 06.10.2026 ==="
tpl monthly 1 "2031-05-01" previous
assert_eq "in arrears from 01.05.2031: 01.06.2031, when May is over" "$(next)" "2031-06-01"
tpl monthly 1 "2031-05-01" none
assert_eq "without a period from 01.05.2031: 01.06.2031" "$(next)" "2031-06-01"

note "=== the first invoice bills the first period ==="
R=$FIRST
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
INV=$(q "select id from \"Invoice\" where \"recurringInvoiceId\"='$R' limit 1")
assert_eq "generated" "$STATUS/$([[ -n "$INV" ]] && echo yes)" "201/yes"
assert_eq "its Leistungszeitraum is May 2031" \
  "$(q "select to_char(\"servicePeriodStart\", 'YYYY-MM-DD')||'/'||to_char(\"servicePeriodEnd\", 'YYYY-MM-DD') from \"Invoice\" where id='$INV'")" "2031-05-01/2031-05-31"
assert_eq "…and the next run bills June" "$(next)" "2031-06-01"

note "=== an edit of the start, a clone ==="
tpl monthly 1 "2031-05-01" current
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"startDate":"2031-09-01"}'
assert_eq "start moved to 01.09.2031: first run 01.09.2031 (was 01.10.)" "$STATUS/$(next)" "200/2031-09-01"
AS POST "/api/v1/recurring-invoices/$R/clone?companyId=$C" '{"startDate":"2031-10-01"}'
R=$(json_field "$BODY" id)
assert_eq "a clone from 01.10.2031: first run 01.10.2031 (was 01.11.)" "$STATUS/$(next)" "201/2031-10-01"

note "=== starting today ==="
TODAY=$(TZ=Europe/Berlin python3 -c "import datetime;print(datetime.date.today().isoformat())")
tpl monthly "$((10#${TODAY:8:2}))" "$TODAY" current
assert_eq "monthly from today, on today's day: first run today" "$(next)" "$TODAY"

summary
