#!/bin/bash
# Tier 425 — the Kassenbuch reaches the books
#
# Measured before, in a month with a 119 € cash sale at 19 %, a 59,50 € cash
# purchase at 19 % and an invoice paid in cash at the counter (entered in the
# Kassenbuch with the invoice linked):
#   UStVA    only the invoice: the cash sale's 19 € undeclared, the purchase's
#            9,50 € input tax not claimed
#   EÜR, GuV, BWA, P&L, Anlage S, DATEV   no trace of either
#   the invoice stayed "sent" with no payment — the dunning run chased it
# Found on the way: EÜR, GuV, BWA, Anlage S and V filtered expenses with
# `category <> 'AfA'`, which in SQL also drops every expense WITHOUT a
# category — the 119 € expense below was in none of them.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-214-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m); TTMM=$(date +%d%m)
FROM=$(date +%Y-%m-01)
TO=$(python3 -c "import datetime,calendar;d=datetime.date.today();print(d.replace(day=calendar.monthrange(d.year,d.month)[1]).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier425-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
entry() { AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$TODAY\",$1}"; [[ "$STATUS" == 201 ]] || fail "cash entry: $STATUS $BODY"; json_field "$BODY" id; }

entry '"type":"eroeffnung","description":"Anfangsbestand","amount":500' >/dev/null
entry '"type":"einnahme","description":"Barverkauf","amount":119,"vatRate":0.19' >/dev/null
entry '"type":"ausgabe","description":"Tanken","amount":59.50,"vatRate":0.19' >/dev/null
entry '"type":"einnahme","description":"Privateinlage","amount":50' >/dev/null

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
INV=$(json_field "$BODY" id); INV_NO=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"}}"; S=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$S\",\"invoiceNumber\":\"ER-1\",\"description\":\"Werkzeug\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
EXP=$(json_field "$BODY" id)

note "=== 1. paying an invoice and an expense in cash ==="
BAR=$(entry "\"type\":\"einnahme\",\"description\":\"Bar $INV_NO\",\"amount\":119,\"vatRate\":0.19,\"invoiceId\":\"$INV\",\"belegNumber\":\"Q-1\"")
assert_eq "the invoice is paid, by a cash payment (was: still sent, no payment)" \
  "$(q "select status||'/'||(select string_agg(\"paymentMethod\"||':'||round(amount,2),',') from \"Payment\" where \"invoiceId\"=i.id) from \"Invoice\" i where id='$INV'")" "paid/cash:119.00"
entry "\"type\":\"ausgabe\",\"description\":\"Bar ER-1\",\"amount\":119,\"vatRate\":0.19,\"expenseId\":\"$EXP\"" >/dev/null
assert_eq "the expense has its payment date" "$(q "select \"paidAt\"::date from \"Expense\" where id='$EXP'")" "$TODAY"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$TODAY\",\"type\":\"ausgabe\",\"description\":\"x\",\"amount\":1,\"invoiceId\":\"$INV\"}"
assert_eq "an Ausgabe cannot be linked to an invoice" "$STATUS" "400"

note "=== 2. the returns ==="
# invoice 100 / 19 + cash sale 100 / 19; input tax: expense 19 + Tanken 9.50.
# The linked cash entries are not counted again; the Privateinlage (no rate) not at all.
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "UStVA 19 %: 200 / 38 (was 100 / 19)" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-6]")" "[(200, 38)]"
assert_eq "UStVA Vorsteuer 19 %: 28.50 (was 19)" "$(P "d['vorsteuer']['from19']")" "28.5"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$YEAR"
assert_eq "EÜR: Einnahmen 200, Ausgaben 150 (was 100 / 0)" "$(P "'%s/%s' % (d['totals']['einnahmenTotal'], d['totals']['ausgabenTotal'])")" "200/150"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$YEAR"
assert_eq "GuV Umsatzerlöse 200 (was 100)" "$(P "[l['amount'] for l in d['revenue']['lines'] if l['position']=='1'][0]")" "200"
assert_eq "GuV sonstige Aufwendungen 150 (was 0 — an expense without a category was dropped)" "$(P "[l['amount'] for l in d['cost']['lines'] if l['position']=='8'][0]")" "150"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "BWA Umsatzerlöse 200 (was 100)" "$(P "[l['monat'] for l in d['lines'] if l['bucket']=='1000'][0]")" "200"
assert_eq "BWA sonstige Kosten 150 (was 0)" "$(P "[l['monat'] for l in d['lines'] if l['bucket']=='3600'][0]")" "150"
AS GET "/api/v1/reports/pnl?companyId=$C&year=$YEAR"
assert_eq "P&L revenue 200 / other expenses 150 (was 100 / 100)" "$(P "'%s/%s' % (d['ytd']['revenue'], d['ytd']['otherExpenses'])")" "200/150"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=$YEAR"
assert_eq "Anlage S 4100: 200 (was 100)" "$(P "[e['amount'] for e in d['einnahmen'] if e['kennziffer']=='4100'][0]")" "200"

note "=== 3. DATEV: Kasse 1000 ==="
export_csv() { curl -sS -o "$1" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TO"; }
export_csv /tmp/t425.csv
ROWS=$(datev_rows /tmp/t425.csv | awk -F'\t' '$3=="1000" {print $4":"$5":"$6":"$7}' | sort | tr '\n' ' ')
assert_eq "cash sale, cash purchase, the invoice paid in cash, the expense paid in cash" \
  "$ROWS" "10000:119.00:S: 4900:59.50:H:9 70001:119.00:H: 8400:119.00:S:3 "

note "=== 4. a Storno of the cash receipt takes the payment back ==="
AS POST "/api/v1/cashbook/entries/$BAR/reverse?companyId=$C" '{"reason":"falsche Rechnung"}'
assert_eq "Storno accepted" "$STATUS" "201"
assert_eq "the invoice is open again, without the payment" \
  "$(q "select status||'/'||(select count(*) from \"Payment\" where \"invoiceId\"=i.id) from \"Invoice\" i where id='$INV'")" "sent/0"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "…and the UStVA is unchanged by it" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-6]")" "[(200, 38)]"

summary; exit $?
