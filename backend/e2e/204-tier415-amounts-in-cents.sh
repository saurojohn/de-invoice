#!/bin/bash
# Tier 415 — invoice amounts are cents, computed once
#
# Amounts were stored to four places and never rounded. Measured:
#   3 × 33,33 € @ 19 %          VAT 18,9981, total 118,9881 (document: 19,00 / 118,99)
#   1,5 × 87,35 @ 19 % +
#   7 × 2,99 @ 7 %              net 151,955, VAT 26,3598, total 178,3149 — the PDF
#                               printed 151,96 + 26,36 = 178,31, which does not add up
#   3 × 0,99 @ 19 %             VAT 0,5643
# The tax owed is the tax stated on the invoice (§ 14c UStG); every report that
# sums stored VAT drifted from it. Create, edit, credit note and the recurring
# run each had their own arithmetic; the recurring preview rounded only its
# totals. The invoice form's live total ignored the discount in its VAT
# (1 000 € − 10 % showed 1 090,00; the invoice said 1 071,00).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-204-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier415-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",$1}"; }
F() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);v=eval(sys.argv[2]);print(v)" "$BODY" "$1"; }

note "=== 1. stored amounts are cents ==="
mk '"items":[{"description":"a","quantity":3,"unit":"Stk","unitPrice":33.33,"vatRate":0.19}]'
assert_eq "3 × 33,33: VAT 19.00 (was 18.9981)" "$(F "d['totalVat']")" "19"
assert_eq "3 × 33,33: total 118.99 (was 118.9881)" "$(F "d['total']")" "118.99"
A_ID=$(json_field "$BODY" id)

mk '"items":[{"description":"a","quantity":1.5,"unit":"Std","unitPrice":87.35,"vatRate":0.19},{"description":"b","quantity":7,"unit":"Stk","unitPrice":2.99,"vatRate":0.07}]'
assert_eq "mixed: line net 131.03 (was 131.025)" "$(F "d['items'][0]['netAmount']")" "131.03"
assert_eq "mixed: subtotal 151.96 (was 151.955)" "$(F "d['subtotal']")" "151.96"
assert_eq "mixed: VAT = 24.90 + 1.47 = 26.37 (was 26.3598)" "$(F "d['totalVat']")" "26.37"
assert_eq "mixed: total 178.33 = 151.96 + 26.37 (was 178.3149)" "$(F "d['total']")" "178.33"
B_ID=$(json_field "$BODY" id)

mk '"items":[{"description":"a","quantity":1,"unit":"Stk","unitPrice":0.99,"vatRate":0.19},{"description":"b","quantity":1,"unit":"Stk","unitPrice":0.99,"vatRate":0.19},{"description":"c","quantity":1,"unit":"Stk","unitPrice":0.99,"vatRate":0.19}]'
assert_eq "3 × 0,99: VAT per rate, 19 % of 2.97 = 0.56 (was 0.5643)" "$(F "d['totalVat']")" "0.56"
assert_eq "3 × 0,99: total 3.53" "$(F "d['total']")" "3.53"

mk '"discountPercent":7.5,"items":[{"description":"a","quantity":3,"unit":"Stk","unitPrice":33.33,"vatRate":0.19}]'
assert_eq "7,5 % off 99,99: discount 7.50" "$(F "d['discountAmount']")" "7.5"
assert_eq "7,5 % off: VAT 19 % of 92.49 = 17.57 (was 17.5732)" "$(F "d['totalVat']")" "17.57"
assert_eq "7,5 % off: total 110.06 (was 110.064)" "$(F "d['total']")" "110.06"

note "=== 2. an edit recomputes in cents, and a percentage discount follows the new lines ==="
# Only an invoice issued today can be edited (Tier 409's same-day rule).
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%F)\",\"discountPercent\":10,\"items\":[{\"description\":\"a\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
E_ID=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$E_ID?companyId=$C" '{"items":[{"description":"a","quantity":3,"unit":"Stk","unitPrice":33.33,"vatRate":0.19}]}'
assert_eq "edit accepted" "$STATUS" "200"
AS GET "/api/v1/invoices/$E_ID?companyId=$C"
assert_eq "edit: discount 10 % of 99.99 = 10.00 (the old 10 % of 100 is not reused)" "$(F "d['discountAmount']")" "10"
assert_eq "edit: VAT 19 % of 89.99 = 17.10" "$(F "d['totalVat']")" "17.1"
assert_eq "edit: total 107.09" "$(F "d['total']")" "107.09"

note "=== 3. the recurring preview equals the invoice the run creates ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"companyId\":\"$C\",\"name\":\"$TAG Abo\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"intervalCount\":1,\"dayOfMonth\":15,\"startDate\":\"2026-06-01\",\"invoiceStatus\":\"draft\",\"sendEmail\":false,\"items\":[{\"description\":\"Wartung\",\"quantity\":1.5,\"unit\":\"Std\",\"unitPrice\":87.35,\"vatRate\":0.19},{\"description\":\"Material\",\"quantity\":7,\"unit\":\"Stk\",\"unitPrice\":2.99,\"vatRate\":0.07}]}"
TPL=$(json_field "$BODY" id)
AS GET "/api/v1/recurring-invoices/$TPL/preview?companyId=$C"
P_VAT=$(F "d['totalVat']"); P_TOTAL=$(F "d['total']")
assert_eq "preview VAT 26.37" "$P_VAT" "26.37"
AS POST "/api/v1/recurring-invoices/$TPL/run?companyId=$C" "{\"companyId\":\"$C\"}"
R_ID=$(json_field "$BODY" invoiceId)
AS GET "/api/v1/invoices/$R_ID?companyId=$C"
assert_eq "run: VAT = preview (was 26.3598 vs 26.36)" "$(F "d['totalVat']")" "$P_VAT"
assert_eq "run: total = preview" "$(F "d['total']")" "$P_TOTAL"

note "=== 4. a credit note is cents too ==="
AS PUT "/api/v1/invoices/$A_ID/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$A_ID/credit-note?companyId=$C" '{}'
assert_eq "full credit note of 118.99: total -118.99 (was -118.9881)" "$(F "d['total']")" "-118.99"

note "=== 5. the document agrees with itself ==="
AS GET "/api/v1/invoices/$B_ID/xrechnung/validate?companyId=$C"
# The fixture company has no address, so the check reports BR-06 & co.; what
# matters here is that no amount rule does (payable = total, tax = totalVat).
assert_eq "XRechnung check: no amount rule broken (BR-CO-14/15)" \
  "$(python3 -c "import sys,json;print(sorted(e['rule'] for e in json.loads(sys.argv[1])['errors'] if e['rule'].startswith('BR-CO')))" "$BODY")" "[]"
F_PDF=/tmp/t415-b.pdf
curl -sS -o "$F_PDF" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$B_ID/pdf?companyId=$C"
pdf_contains "178,33" "$F_PDF" && pass "PDF total 178,33" || fail "PDF total 178,33 missing"
pdf_contains "26,37" "$F_PDF" && pass "PDF VAT 26,37 (19 % 24,90 + 7 % 1,47)" || fail "PDF VAT 26,37 missing"

note "=== 6. the invoice form uses the same arithmetic ==="
# frontend/src/lib/invoice-amounts.ts is a copy of the backend module (separate
# packages). The code below the header comment must be identical.
BACK="$SCRIPT_DIR/../src/modules/invoice/invoice-amounts.ts"
FRONT="$SCRIPT_DIR/../../frontend/src/lib/invoice-amounts.ts"
body() { sed -n '/^export interface AmountLine/,$p' "$1"; }
if [[ -f "$FRONT" ]] && diff <(body "$BACK") <(body "$FRONT") >/dev/null; then
  pass "frontend/src/lib/invoice-amounts.ts matches the backend module"
else
  fail "frontend and backend invoice-amounts.ts differ"
fi

summary; exit $?
