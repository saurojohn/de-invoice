#!/bin/bash
# Tier 416 — a credit note takes back what the invoice stated, at its rates
#
# Measured before:
#   full credit note of 1 000 € − 10 % @ 19 % (1 071 €)    −1 190 €, VAT −190
#     (the discount was not mirrored: 19 € more VAT taken back than charged)
#   refund of 119 € by amount on a 19 % invoice            −119 € at 0 % VAT
#     (the dialog's "Erstattungsbetrag" — every partial refund — never
#     reduced output tax; § 17 UStG)
#   refund line without a rate on a 7 % invoice            booked at 19 %
#   two full refunds of a 1 190 € invoice                  both accepted, −2 380 €
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-205-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier416-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
sent() { # body-fragment → id of a sent invoice issued today
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",$1}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
F() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
L19='{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}'

note "=== 1. a full credit note mirrors the discount ==="
D=$(sent "\"discountPercent\":10,\"items\":[$L19]")
AS POST "/api/v1/invoices/$D/credit-note?companyId=$C" '{}'
assert_eq "total -1071 (was -1190)" "$(F "d['total']")" "-1071"
assert_eq "VAT -171 (was -190)" "$(F "d['totalVat']")" "-171"

note "=== 2. a refund by amount is gross, at the original's rates ==="
P=$(sent "\"items\":[$L19]")
AS POST "/api/v1/invoices/$P/credit-note?companyId=$C" '{"amount":119,"reason":"Kulanz"}'
assert_eq "119 € refund: net -100 (was -119)" "$(F "d['subtotal']")" "-100"
assert_eq "119 € refund: VAT -19 (was 0)" "$(F "d['totalVat']")" "-19"
assert_eq "119 € refund: total -119" "$(F "d['total']")" "-119"
assert_eq "the line carries 19 %" "$(F "float(d['items'][0]['vatRate'])")" "0.19"

M=$(sent '"items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
AS POST "/api/v1/invoices/$M/credit-note?companyId=$C" '{"amount":113}'
assert_eq "half of a 19 % + 7 % invoice (226): two lines" "$(F "len(d['items'])")" "2"
assert_eq "half: VAT -9.50 - 3.50 = -13" "$(F "d['totalVat']")" "-13"
assert_eq "half: total -113" "$(F "d['total']")" "-113"

note "=== 3. a refund line without a rate takes the original's ==="
S=$(sent '"items":[{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
AS POST "/api/v1/invoices/$S/credit-note?companyId=$C" '{"lines":[{"description":"Buch zurück","unitPrice":50}]}'
assert_eq "7 % invoice: refund line at 7 % (was 19 %)" "$(F "float(d['items'][0]['vatRate'])")" "0.07"
assert_eq "7 % invoice: VAT -3.50 (was -9.50)" "$(F "d['totalVat']")" "-3.5"
AS POST "/api/v1/invoices/$M/credit-note?companyId=$C" '{"lines":[{"description":"ohne Satz","unitPrice":10}]}'
assert_eq "mixed-rate original: a line without a rate is refused" "$STATUS" "400"

note "=== 4. credit notes cannot exceed the invoice ==="
Q=$(sent "\"items\":[$L19]")
AS POST "/api/v1/invoices/$Q/credit-note?companyId=$C" '{"amount":1190}'
assert_eq "first full refund accepted" "$STATUS" "201"
AS POST "/api/v1/invoices/$Q/credit-note?companyId=$C" '{"amount":1190}'
assert_eq "second full refund refused (was accepted: -2380)" "$STATUS" "400"
R=$(sent "\"items\":[$L19]")
AS POST "/api/v1/invoices/$R/credit-note?companyId=$C" '{"amount":500}'
AS POST "/api/v1/invoices/$R/credit-note?companyId=$C" '{}'
assert_eq "a 'full' refund after a partial one credits what is left: -690" "$(F "d['total']")" "-690"
AS POST "/api/v1/invoices/$R/credit-note?companyId=$C" '{"amount":0.01}'
assert_eq "nothing left to credit" "$STATUS" "400"

note "=== 5. the UStVA sees the reduced tax ==="
# This month, 19 %: D 900/171 − 900/171, P 1000/190 − 100/19, M 100/19 − 50/9.50,
# Q 1000/190 − 1000/190, R 1000/190 − 1000/190  →  net 950, VAT 180.50
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
RATE() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);r=[x for x in d['salesByRate'] if abs(x['rate']-float(sys.argv[2]))<1e-6];print('%s/%s'%(r[0]['net'],r[0]['vat']) if r else '-')" "$BODY" "$1"; }
assert_eq "19 %: net/VAT after the credit notes" "$(RATE 0.19)" "950/180.5"

summary; exit $?
