#!/bin/bash
# Tier 478 — today is the business's calendar day
#
# Date-only fields are stored as midnight UTC. The dashboard bounded "this
# month" / YTD by `now`; on a German server an invoice dated today is 02:00
# local, so after midnight it was left out — measured: spec 213 at 00:11 on
# 30.09.2026, dashboard this month 0 / 0 / 0 instead of 702 / 102 / 2. The
# customer summary counted an invoice as overdue once `dueDate > now` failed —
# on a UTC server (CI) from 00:00 on its due day. Which of the two shows
# depends on the server's clock; both assertions are checked everywhere.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-264-$(date +%s%N | cut -c1-13)"
read -r TODAY YESTERDAY < <(python3 -c "
import datetime, zoneinfo
t = datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()
print(t.isoformat(), (t - datetime.timedelta(days=1)).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier478-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company (today in Germany: $TODAY)" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
inv() { # issueDate dueDate
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
inv "$TODAY" "$TODAY"

AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard this month counts today's invoice (was 0/0/0 after midnight on a German server)" \
  "$(P "'%s/%s/%s' % (d['thisMonth']['revenue'], d['thisMonth']['ust'], d['thisMonth']['countInvoices'])")" "119/19/1"
AS GET "/api/v1/customers/$K/summary?companyId=$C"
assert_eq "due today: not overdue yet (was overdue all day on a UTC server)" "$(P "d['stats']['overdueCount']")" "0"

inv "$YESTERDAY" "$YESTERDAY"
AS GET "/api/v1/customers/$K/summary?companyId=$C"
assert_eq "due yesterday: overdue" "$(P "d['stats']['overdueCount']")" "1"

# A credit note is dated the day it is written. It took the instant: written
# at 00:15 on 30.09. in Germany it was dated 29.09. (22:15 UTC) — spec 212's
# DATEV check failed on it; at a month end it lands in the previous UStVA.
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
CI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$CI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$CI/credit-note?companyId=$C" '{"amount":119}'
assert_eq "the credit note is dated today in Germany" "$(P "d['issueDate'][:10]")" "$TODAY"

summary
