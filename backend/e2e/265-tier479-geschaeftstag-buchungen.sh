#!/bin/bash
# Tier 479 — dates the system sets itself are the German day
#
# Tier 478 found credit notes dated with the instant (written at 00:15 on
# 30.09., dated 29.09.). The same `new Date()` was stored as the date of a
# voucher Storno / correction, of a customer credit applied to an invoice,
# and of an invoice from a recurring template's run — and the invoice
# number's year came from the server's local date. Between 00:00 and 02:00
# in Germany that is the previous day; on the 1st, the previous month's
# UStVA / EÜR period, on 1 January the previous year. (Checked with fixed
# instants: 2026-09-30T22:30Z → stored 30.09., the German day is 01.10.) This
# spec pins the dates to the German day; it fails on the old code only when
# run between 00:00 and 02:00 German time, or on a UTC server from 22:00.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-265-$(date +%s%N | cut -c1-13)"
TODAY=$(python3 -c "import datetime, zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier479-e2e\",\"companyName\":\"$TAG Handel\"}" \
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

note "=== voucher Storno ==="
AS GET "/api/v1/accounting/accounts/seed?companyId=$C"
AS GET "/api/v1/accounting/accounts?companyId=$C"; echo "$BODY" > /tmp/t479-acc.json
acc() { python3 -c "import json;d=json.load(open('/tmp/t479-acc.json'));d=d if isinstance(d,list) else d.get('data',d);print([a['id'] for a in d if a['accountNumber']=='$1'][0])"; }
AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-15\",\"description\":\"Barverkauf\",\"referenceType\":\"Manual\",\"lines\":[{\"accountId\":\"$(acc 1000)\",\"debit\":100,\"credit\":0},{\"accountId\":\"$(acc 8200)\",\"debit\":0,\"credit\":100}]}"
V=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"Fehlbuchung"}'
assert_eq "Storno booked" "$STATUS" "201"
assert_eq "…dated today in Germany" "$(P "(d.get('reversal') or d).get('date', '')[:10]")" "$TODAY"

note "=== customer credit applied ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/customers/$K/credit-adjust?companyId=$C" '{"amount":50,"description":"Guthaben"}'
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$I\",\"amount\":50}"
assert_eq "credit applied" "$STATUS" "201"
AS GET "/api/v1/invoices/$I/payments?companyId=$C"
assert_eq "…as a payment dated today in Germany" \
  "$(P "[(p['paymentMethod'], p['paymentDate'][:10]) for p in (d if isinstance(d,list) else d.get('data',d))]")" "[('Guthaben', '$TODAY')]"

note "=== recurring run ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG Abo\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"$TODAY\",\"items\":[{\"description\":\"Hosting\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}],\"sendEmail\":false}"
T=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C"
RI=$(P "d.get('invoiceId') or (d.get('invoice') or {}).get('id', '')")
AS GET "/api/v1/invoices/$RI?companyId=$C"
assert_eq "the invoice of the run is dated today in Germany (a date, no time)" "$(P "d['issueDate']")" "${TODAY}T00:00:00.000Z"
assert_eq "…numbered in the German year" "$(P "d['invoiceNumber'][4:8]")" "${TODAY:0:4}"

summary
