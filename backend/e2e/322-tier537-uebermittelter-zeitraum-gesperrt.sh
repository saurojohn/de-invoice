#!/bin/bash
# Tier 537 — a submitted UStVA locks its period
#
# Decided by the user (06.10.2026). Until now a return sent to the Finanzamt
# locked nothing: an invoice could be issued into its month, an expense
# entered, changed or deleted there, an issued invoice cancelled — the history
# then said "Berichtigung nötig" (Tier 449). Measured before: all of the
# requests below answered 2xx.
#
# Now a document dated into a submitted period is refused (400, naming the
# period and both ways out): correct in the current period, or release the
# period ("Zeitraum freigeben"), change, and submit a corrected return — which
# locks it again.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-322-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C K
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier537-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
  K=$(json_field "$BODY" id)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
ITEM='[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
draft() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":$ITEM}"; I=$(json_field "$BODY" id); }
issue() { AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
expense() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"$TAG\",\"invoiceDate\":\"$1\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"; }
submit() { # year month [extra python] — the month's return as computed
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"
  AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';${3:-pass};print(json.dumps(d))" "$BODY")"
  F=$(json_field "$BODY" id)
}
company A
[[ -n "${C:-}" && -n "${K:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }

note "=== June 2026 is booked and submitted ==="
draft "2026-06-10"; issue; INV=$I
assert_eq "an invoice of 10.06." "$STATUS" "200"
expense "2026-06-12"; EXP=$(json_field "$BODY" id)
draft "2026-06-20"; LATE=$I   # a draft dated into June, not issued yet
submit 2026 6
assert_eq "the UStVA 2026-06 is submitted" "$STATUS" "201"
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "…and its period shows as locked" "$(P "[x['locked'] for x in d if x['id']=='$F']")" "[True]"

note "=== documents of June ==="
I=$LATE; issue
assert_eq "issuing the draft dated 20.06.: 400 (was 200)" "$STATUS" "400"
assert_eq "…the message names the period and the ways out" "$(P "'2026-06' in d['message'] and 'Verlauf“ frei' in d['message'] and 'Gutschrift' in d['message']")" "True"
I=$INV; AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "cancelling the invoice of 10.06.: 400 (was 200)" "$STATUS/$(q "select status from \"Invoice\" where id='$INV'")" "400/sent"
expense "2026-06-25"
assert_eq "an expense dated 25.06.: 400 (was 201)" "$STATUS" "400"
AS PUT "/api/v1/ustva/expenses/$EXP?companyId=$C" '{"netAmount":200}'
assert_eq "changing the expense of 12.06.: 400 (was 200)" "$STATUS" "400"
AS DELETE "/api/v1/ustva/expenses/$EXP?companyId=$C"
assert_eq "deleting it: 400 (was 200)" "$STATUS/$(q "select count(*) from \"Expense\" where id='$EXP'")" "400/1"
AS POST "/api/v1/expenses/import?companyId=$C" "{\"rows\":[{\"description\":\"$TAG Juni\",\"invoiceDate\":\"2026-06-28\",\"supplierName\":\"$TAG L\",\"netAmount\":\"10\"},{\"description\":\"$TAG Juli\",\"invoiceDate\":\"2026-07-02\",\"supplierName\":\"$TAG L\",\"netAmount\":\"10\"}]}"
assert_eq "an import: the June row reported, the July row in" "$(P "d['imported']")/$(P "'2026-06' in d['errors'][0]['error']")" "1/True"
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2026-06-15","type":"einnahme","description":"Barverkauf","amount":119,"vatRate":0.19}'
assert_eq "a cash sale with VAT on 15.06.: 400 (was 201)" "$STATUS" "400"
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2026-06-15","type":"einnahme","description":"Privateinlage","amount":50}'
assert_eq "a Kassenbuch entry without VAT on 15.06.: booked" "$STATUS" "201"

note "=== other periods, and what moves no VAT ==="
expense "2026-07-03"
assert_eq "an expense of July: recorded" "$STATUS" "201"
draft "2026-07-05"; issue
assert_eq "an invoice of July: issued" "$STATUS" "200"
I=$INV; AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":119,"paymentDate":"2026-06-28","paymentMethod":"bank_transfer"}'
assert_eq "a payment of the June invoice dated 28.06. (Soll-Versteuerung): recorded" "$STATUS" "201"
draft "2026-07-06"; issue
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "the correction in the current period — a credit note dated today: created" "$STATUS" "201"

note "=== released, corrected, locked again ==="
AS PUT "/api/v1/ustva/filings/$F/release?companyId=$C" '{"released":true}'
assert_eq "the period is released" "$STATUS/$(P "d['locked']")" "200/False"
expense "2026-06-25"
assert_eq "now the expense dated 25.06. is recorded" "$STATUS" "201"
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "the history says a corrected return is needed" "$(P "[x['berichtigungNoetig'] for x in d if x['id']=='$F']")" "[True]"
submit 2026 6 "d['berichtigt']=True"
assert_eq "the corrected return is submitted" "$STATUS" "201"
expense "2026-06-26"
assert_eq "…and June is locked again" "$STATUS" "400"
AS PUT "/api/v1/ustva/filings/$F/release?companyId=$C" '{"released":true}'
AS PUT "/api/v1/ustva/filings/$F/release?companyId=$C" '{"released":false}'
assert_eq "released and locked again by hand" "$STATUS/$(P "d['locked']")" "200/True"

note "=== a quarter, a draft, another company ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&quarter=1"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "Q1 2026 submitted" "$STATUS" "201"
expense "2026-02-14"
assert_eq "an expense of February: 400 — the quarter is locked" "$STATUS" "400"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=8"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$BODY")"
DRAFT=$(json_field "$BODY" id)
expense "2026-08-14"
assert_eq "August saved as a draft only: an expense of August is recorded" "$STATUS" "201"
AS PUT "/api/v1/ustva/filings/$DRAFT/release?companyId=$C" '{"released":true}'
assert_eq "a draft has nothing to release: 400" "$STATUS" "400"
FA=$F; company B
expense "2026-06-25"
assert_eq "another company's June is its own: recorded" "$STATUS" "201"
AS PUT "/api/v1/ustva/filings/$FA/release?companyId=$C" '{"released":true}'
assert_eq "…and it cannot release A's period: 404" "$STATUS" "404"

summary
