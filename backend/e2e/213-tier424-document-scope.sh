#!/bin/bash
# Tier 424 — which documents count where
#
# A Proforma-Rechnung (PI) asks for payment in advance; it is no invoice in
# the sense of § 14 UStG — no revenue, no tax, nothing owed. A Quittung (RCV)
# is a sale with its own line items and VAT. Measured before, on one sent PI
# (1 000 net at 19 %), one sent RCV (100 net at 7 %), one sent INV (500 net
# at 19 %) and one draft:
#   UStVA         19 %: 1 500 / 285 (the PI declared), 7 %: nothing (the RCV missed)
#   GuV / BWA / P&L revenue 1 600 (the PI counted; the P&L also the draft)
#   ageing        1 785 open (the PI "owed", the RCV not)
#   dashboard     revenue with drafts and the PI, VAT = total × 19/119, unrounded
# And the customer statement counted a credit note twice (once as the credit
# note, once as the synthetic "Gutschrift" payment it books): a 1 190 € invoice
# with a 190 € credit note showed 810 € owed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-213-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m)
FROM=$(date +%Y-%m-01)
TO=$(python3 -c "import datetime,calendar;d=datetime.date.today();print(d.replace(day=calendar.monthrange(d.year,d.month)[1]).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier424-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
doc() { # type price rate status
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"$1\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  local id; id=$(json_field "$BODY" id)
  [[ "$4" == draft ]] || AS PUT "/api/v1/invoices/$id/status?companyId=$C" "{\"status\":\"$4\"}"
  echo "$id"
}
PI=$(doc PI 1000 0.19 sent); RCV=$(doc RCV 100 0.07 sent); INV=$(doc INV 500 0.19 sent); DRAFT=$(doc INV 300 0.19 draft)
[[ -n "$PI" && -n "$RCV" && -n "$INV" && -n "$DRAFT" ]] && pass "fixture: PI, RCV, INV, draft" || fail "fixtures"

note "=== 1. the UStVA declares the Quittung, not the Proforma ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "per rate (was 19 %: 1500/285 and no 7 %)" \
  "$(P "sorted(('%g' % r['rate'], r['net'], r['vat']) for r in d['salesByRate'])")" "[('0.07', 100, 7), ('0.19', 500, 95)]"

note "=== 2. revenue ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=$YEAR"
assert_eq "GuV Umsatzerlöse 600 (was 1 600)" "$(P "[l['amount'] for l in d['revenue']['lines'] if l['position']=='1'][0]")" "600"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "BWA Umsatzerlöse 600 (was 1 600)" "$(P "[l['monat'] for l in d['lines'] if l['bucket']=='1000'][0]")" "600"
AS GET "/api/v1/reports/pnl?companyId=$C&year=$YEAR"
assert_eq "P&L revenue 600 (was 1 900 — the draft too)" "$(P "d['ytd']['revenue']")" "600"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=$YEAR"
assert_eq "Anlage S 4100: 600 (was 1 600)" "$(P "[e['amount'] for e in d['einnahmen'] if e['kennziffer']=='4100'][0]")" "600"

note "=== 3. what is owed ==="
AS GET "/api/v1/reports/aging?companyId=$C"
assert_eq "ageing: INV 595 + RCV 107 (was 1 785 — the PI, not the RCV)" "$(P "d['grandTotal']")" "702"
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard this month: gross 702, VAT 102 (was the draft and the PI in, VAT total × 19/119)" \
  "$(P "'%s/%s/%s' % (d['thisMonth']['revenue'], d['thisMonth']['ust'], d['thisMonth']['countInvoices'])")" "702/102/2"

note "=== 4. DATEV ==="
curl -sS -o /tmp/t424.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TO"
assert_eq "the Quittung on 8300 with key 2, no Proforma row" \
  "$(datev_rows /tmp/t424.csv | awk -F'\t' '{print substr($1,1,3) ":" $4 ":" $5 ":" $7}' | sort | tr '\n' ' ')" "INV:8400:595.00:3 RCV:8300:107.00:2 "

note "=== 5. the customer statement counts a credit note once ==="
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Konto\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
S=$(doc INV 1000 0.19 sent)
AS POST "/api/v1/invoices/$S/credit-note?companyId=$C" '{"amount":190}'
AS GET "/api/v1/customers/$K/statement?companyId=$C&from=$YEAR-01-01&to=$TODAY"
assert_eq "closing balance 1 000 (was 810)" "$(P "d['closingBalance']")" "1000"
assert_eq "…lines: the invoice and the credit note, no synthetic payment" "$(P "sorted(l['type'] for l in d['lines'])")" "['credit', 'invoice']"

summary; exit $?
