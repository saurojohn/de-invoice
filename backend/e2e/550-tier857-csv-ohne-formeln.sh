#!/bin/bash
# Tier 857 — no exported CSV cell is a formula
#
# Security audit (18.11.2026), item 6. A spreadsheet runs a cell that begins
# with = + - @ as a formula. The invoice list and the cash book wrote what was
# typed as it was: a customer called =HYPERLINK("https://…";"Zahlung") became
# a link in the file the owner or the Steuerberater opens; so did a cash book
# entry, an asset's name in the Berater package, a webhook's name, a line of
# the audit log. Only the hours report (Tier 628) wrote such a name with a
# leading apostrophe.
#
# Now common/csv.ts `csvText` does that for every CSV a person opens; a number
# (-12,50) stays a number. DATEV EXTF and the GoBD data sets keep their exact
# values (a program reads them).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SRC="$SCRIPT_DIR/../src"
TAG="e2e-550-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
csv() { curl -sS -o "$2" -w '%{http_code}' "$API$1" -H "x-user-id: $U" -H "x-company-id: $C"; }
# the cells of line $2 of file $1, one per line (a real CSV reader: quotes, semicolons)
cells() { python3 -c "
import csv,sys
rows=list(csv.reader(open(sys.argv[1], encoding='utf-8-sig', newline=''), delimiter=';'))
print('\n'.join(rows[int(sys.argv[2])-1]))" "$1" "$2"; }
# how many cells of a file a spreadsheet would run as a formula
formulas() { python3 -c "
import csv,re,sys
n=0
for row in csv.reader(open(sys.argv[1], encoding='utf-8-sig', newline=''), delimiter=';'):
  for c in row:
    if re.match(r'[=+\-@\t\r]', c) and not re.fullmatch(r'[+-]?\d[\d.,]*', c): n+=1
print(n)" "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
CASHDAY=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=2)).isoformat())")

note "=== 1. the rule ==="
OUT=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
import { csvText, csvCell } from './src/common/csv'
const t = ['=1+1', '+49 30 1234', '-2+3', '@SUMME(A1)', '\t=1', '-', '-12,50', '+3', '-1.234,56', '1234,56', 'RE-2026-001', 'Müller GmbH', '']
console.log(t.map(csvText).join('|'))
console.log(csvCell('=HYPERLINK(\"https://x.test\";\"Zahlung\")'))
" 2>&1)
assert_eq "text that begins like a formula: an apostrophe; numbers and other text as they are" "$(sed -n 1p <<<"$OUT" | tr '\t' 'T')" \
  "'=1+1|'+49 30 1234|'-2+3|'@SUMME(A1)|'T=1|'-|-12,50|+3|-1.234,56|1234,56|RE-2026-001|Müller GmbH|"
assert_eq "…before the cell is quoted for its semicolon" "$(sed -n 2p <<<"$OUT")" "\"'=HYPERLINK(\"\"https://x.test\"\";\"\"Zahlung\"\")\""

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier857-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
CUST_BODY=$(python3 -c "import json;print(json.dumps({'name':'=HYPERLINK(\"https://pay.example.test\";\"Zahlung\")','type':'business','address':{'street':'Ring 2','postalCode':'80331','city':'München','country':'DE'}}))")
AS POST "/api/v1/customers?companyId=$C" "$CUST_BODY"; K=$(json_field "$BODY" id)
assert_eq "fixture: a customer whose name is a formula" "$STATUS" "201"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'; I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an invoice to it" "$STATUS" "200"

note "=== 2. the invoice list ==="
CODE=$(csv "/api/v1/invoices/export/csv?companyId=$C&dateFrom=$TODAY&dateTo=$TODAY" "$TMP/inv.csv")
assert_eq "the customer's name as text (was: =HYPERLINK(…), a link in Excel)" "$CODE $(cells "$TMP/inv.csv" 2 | sed -n 7p)" \
  "200 '=HYPERLINK(\"https://pay.example.test\";\"Zahlung\")"
assert_eq "no cell of the file is a formula" "$(formulas "$TMP/inv.csv")" "0"

note "=== 3. the cash book ==="
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$CASHDAY'","type":"einnahme","description":"@SUMME(A1:A9)","counterparty":"+49 30 1234","notes":"-2+3","amount":50}'
assert_eq "fixture: an entry typed like formulas" "$STATUS" "201"
CODE=$(csv "/api/v1/cashbook/export?companyId=$C&from=$CASHDAY&to=$CASHDAY" "$TMP/kasse.csv")
assert_eq "description, counterparty and note as text (was: @SUMME…, +49…, -2+3 — formulas)" \
  "$CODE $(cells "$TMP/kasse.csv" 2 | sed -n '3p;4p;8p' | tr '\n' '|')" "200 '@SUMME(A1:A9)|'+49 30 1234|'-2+3|"
assert_eq "the amount is still a number" "$(cells "$TMP/kasse.csv" 2 | sed -n 6p)" "50,00"
assert_eq "no cell of the file is a formula" "$(formulas "$TMP/kasse.csv")" "0"

note "=== 4. the hours report (as since Tier 628) ==="
AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'$TODAY'","minutes":60,"description":"Beratung","customerId":"'$K'","hourlyRate":80}'
CODE=$(csv "/api/v1/time-entries/report.csv?companyId=$C&groupBy=customer&from=$TODAY&to=$TODAY" "$TMP/zeit.csv")
assert_eq "the name as text" "$CODE $(cells "$TMP/zeit.csv" 2 | sed -n 1p)" "200 '=HYPERLINK(\"https://pay.example.test\";\"Zahlung\")"
assert_eq "no cell of the file is a formula" "$(formulas "$TMP/zeit.csv")" "0"

note "=== 5. the other exports a person opens use the rule ==="
for f in modules/audit/audit.service.ts:2 modules/webhook/webhook.service.ts:1 modules/accounting/berater-packager.service.ts:1 modules/customer/customer-statement-batch.service.ts:1 modules/time-tracking/time-entry.service.ts:1; do
  file=${f%%:*}; want=${f##*:}
  assert_eq "$file: its CSV cells go through csvText" "$(grep -cE 'const s = csvText\(v\)|const text = csvText' "$SRC/$file")" "$want"
done
assert_eq "the statement batch's index: the customer number too (it was written as typed)" \
  "$(grep -c 'this.csvEscape(stmt.customer.customerNumber' "$SRC/modules/customer/customer-statement-batch.service.ts")/$(grep -c 'this.csvEscape(cust.customerNumber' "$SRC/modules/customer/customer-statement-batch.service.ts")" "1/1"
assert_eq "DATEV and the GoBD data sets keep their exact values" \
  "$(grep -lE 'csvText|csvCell' "$SRC/modules/reports/datev-buchungsliste.service.ts" "$SRC/modules/gobd-export/z3-dataset.ts" "$SRC/modules/gobd-export/gobd-export.service.ts" "$SRC/modules/accounting/gobd-archive.service.ts" 2>/dev/null | wc -l | tr -d ' ')" "0"
summary
