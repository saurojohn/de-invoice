#!/bin/bash
# Tier 881 — a template with a start in the past says what it will not bill
#
# Found on the production images (the second walk): a monthly template
# „Wartungsvertrag“ from 01.09., entered on 20.11., was saved without a word
# and showed „Nächste: 01.12.“ — September to November were never invoiced
# (Tier 535: no catch-up, decided), and „Generieren“ billed December, not a
# skipped month. The answer to the create now carries the stretch that is not
# billed; the form shows it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-573-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier881-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
unbilled() { python3 -c "import json,sys
d=json.loads(sys.argv[1]).get('unbilled')
print('none' if d is None else d['from']+'..'+d['until']+' first '+d['firstRun'])" "$BODY"; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"Abo 573 GmbH","type":"business","address":{"street":"Weg 1","city":"Hamburg","postalCode":"20095","country":"DE"}}'
K=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['id'])" "$BODY")
TODAY=$(TZ=Europe/Berlin date +%F)
# the dates the schedule gives (dayOfMonth 1): the first of the month two
# months back as the start; the next 1st from today on as the first run
read -r START NEXT UNTIL_CUR UNTIL_PREV < <(python3 - "$TODAY" <<'PY'
import datetime, sys
t = datetime.date.fromisoformat(sys.argv[1])
def first(y, m):
    while m < 1: y, m = y - 1, m + 12
    while m > 12: y, m = y + 1, m - 12
    return datetime.date(y, m, 1)
start = first(t.year, t.month - 2)
nxt = t if t.day == 1 else first(t.year, t.month + 1)
prev_start = first(nxt.year, nxt.month - 1)
print(start, nxt, nxt - datetime.timedelta(days=1), prev_start - datetime.timedelta(days=1))
PY
)
tpl() { printf '{"name":"Wartung","customerId":"%s","interval":"monthly","intervalCount":1,"dayOfMonth":1,"startDate":"%s","servicePeriod":"%s","invoiceStatus":"draft","items":[{"description":"Wartung","quantity":1,"unit":"Monat","unitPrice":200,"vatRate":0.19}]}' "$K" "$1" "$2"; }

note "=== 1. billed in advance, from two months back ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "$(tpl "$START" current)"
assert_eq "the answer names what is not billed (was: saved without a word)" "$STATUS $(unbilled)" "201 $START..$UNTIL_CUR first $NEXT"
assert_eq "…and the schedule is as before (Tier 535: no catch-up)" "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['nextRunAt'][:10])" "$BODY")" "$NEXT"

note "=== 2. billed in arrears: the first run bills the month before it ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "$(tpl "$START" previous)"
assert_eq "not billed: up to the month the first run bills" "$STATUS $(unbilled)" "201 $START..$UNTIL_PREV first $NEXT"

note "=== 3. a start from today on: nothing to say ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "$(tpl "$NEXT" current)"
assert_eq "no stretch" "$STATUS $(unbilled)" "201 none"
summary
