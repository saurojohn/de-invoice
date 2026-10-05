#!/bin/bash
# Tier 518 — due before the invoice exists; a subscription that ends before it starts
#
# Measured before: an invoice created today with "fällig 01.01.2020" was
# stored, and once issued it stood in the dunning list 2 400+ days overdue —
# the fee preview asked for Verzugszinsen (§ 288 BGB) since 2020 on a claim
# that did not exist then. Editing a draft's due date to before its issue
# date was taken too. A recurring template with an end date before its start
# was stored and never ran.
#
# Now: 400 for all three. Due on the issue day ("sofort fällig") stays a term.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-303-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier518-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
YESTERDAY=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=1)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
ITEMS='[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"dueDate\":\"$1\",\"items\":$ITEMS}"; }

note "=== an invoice ==="
inv "2020-01-01"
assert_eq "due 01.01.2020, issued today: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Fälligkeitsdatum' in d['message']")" "True"
inv "$YESTERDAY"
assert_eq "due yesterday: 400 (was 201)" "$STATUS" "400"
assert_eq "…nothing stored" "$(q "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "0"
inv "$TODAY"
assert_eq "due on the issue day (sofort fällig): fine" "$STATUS" "201"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"dueDate":"2020-01-01"}'
assert_eq "editing the draft's due date to 2020: 400 (was 200)" "$STATUS" "400"
assert_eq "…it keeps its due date" "$(q "select \"dueDate\"::date from \"Invoice\" where id='$I'")" "$TODAY"
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"dueDate":"2030-01-01"}'
assert_eq "a later one: fine" "$STATUS" "200"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/reminders/overdue?companyId=$C"
assert_eq "nothing is overdue" "$(P "len(d)")" "0"

note "=== a recurring invoice ==="
rec() { AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"2026-11-01\",\"endDate\":$1,\"items\":$ITEMS}"; }
rec '"2026-01-01"'
assert_eq "ending before it starts: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Enddatum' in d['message']")" "True"
rec '"2027-01-01"'
assert_eq "ending after: stored" "$STATUS" "201"
R=$(json_field "$BODY" id)
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"endDate":"2026-06-30"}'
assert_eq "moving the end before the start: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"name":"umbenannt"}'
assert_eq "renaming it: fine" "$STATUS" "200"
AS PUT "/api/v1/recurring-invoices/$R?companyId=$C" '{"endDate":null}'
assert_eq "removing the end: fine" "$STATUS" "200"

summary
