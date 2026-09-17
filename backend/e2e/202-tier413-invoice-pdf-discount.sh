#!/bin/bash
# Tier 413 — the invoice document states the discount and the VAT per rate
#
# The PDF the customer receives printed the line sum *before* the invoice
# discount, one blended VAT figure and the discounted total. Measured, a
# 1 000 € invoice at 10 % off:
#
#   Zwischensumme (Netto):  1.000,00
#   Gesamtbetrag USt:         171,00     → 1 000 + 171 = 1 171, not 1 071
#   Gesamtbetrag:           1.071,00
#
# with no discount line at all (§ 14 Abs. 4 Nr. 7 UStG: the agreed reduction
# must be stated), and a 19 % + 7 % invoice showed neither rate's tax
# (Nr. 8: the rate and the tax amount for it). `formatVatRate` printed "0%"
# for any rate other than 19 % or 7 % — a 16 % or 5 % line (2020) stated the
# wrong rate.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-202-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier413-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",$1}"; json_field "$BODY" id; }
DISC=$(mk '"discountPercent":10,"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]')
MIXED=$(mk '"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
MIXDISC=$(mk '"discountPercent":10,"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
# A rate the old formatVatRate did not know. 2020's 16 % is the real-world case.
RATE16=$(mk '"items":[{"description":"Leistung 2020","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.16}]')
PLAIN=$(mk '"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]')
[[ -n "$DISC" && -n "$MIXED" && -n "$MIXDISC" && -n "$RATE16" && -n "$PLAIN" ]] \
  && pass "fixture: five invoices" || { fail "invoice fixtures"; summary; exit 1; }

pdf() { # id file
  curl -sS -o "$2" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$1/pdf?companyId=$C"
}
in_pdf() { # label file needle
  if pdf_contains "$3" "$2"; then pass "$1"; else fail "$1 — missing: $3"; fi
}
not_in_pdf() {
  if pdf_contains "$3" "$2"; then fail "$1 — still present: $3"; else pass "$1"; fi
}

note "=== 1. a discounted invoice states the discount (§ 14 Abs. 4 Nr. 7) ==="
F=/tmp/t413-disc.pdf; pdf "$DISC" "$F"
in_pdf "Zwischensumme 1.000,00" "$F" "1.000,00"
in_pdf "Rabatt 10 %" "$F" "Rabatt 10 %:"
in_pdf "Rabatt amount -100,00" "$F" "-100,00"
in_pdf "Nettobetrag" "$F" "Nettobetrag:"
in_pdf "900,00 (the taxable amount)" "$F" "900,00"
in_pdf "USt 19 % = 171,00" "$F" "USt 19 %:"
in_pdf "Gesamtbetrag 1.071,00" "$F" "1.071,00"

note "=== 2. several rates are listed per rate (§ 14 Abs. 4 Nr. 8) ==="
F=/tmp/t413-mixed.pdf; pdf "$MIXED" "$F"
in_pdf "USt 19 % on its own Entgelt" "$F" "USt 19 % auf"
in_pdf "USt 7 % on its own Entgelt" "$F" "USt 7 % auf"
in_pdf "19 % tax amount 19,00" "$F" "19,00"
in_pdf "7 % tax amount 7,00" "$F" "7,00"
in_pdf "sum still shown" "$F" "Gesamtbetrag USt:"

F=/tmp/t413-mixdisc.pdf; pdf "$MIXDISC" "$F"
in_pdf "discounted mixed: Rabatt" "$F" "Rabatt 10 %:"
in_pdf "discounted mixed: 19 % on 90,00" "$F" "17,10"
in_pdf "discounted mixed: 7 % on 90,00" "$F" "6,30"
in_pdf "discounted mixed: total 203,40" "$F" "203,40"

note "=== 3. a rate other than 19 / 7 prints its own rate ==="
F=/tmp/t413-16.pdf; pdf "$RATE16" "$F"
in_pdf "16 % stated" "$F" "USt 16 %:"
not_in_pdf "not stated as 0 %" "$F" "USt 0 %:"

note "=== 4. a plain invoice keeps its layout ==="
F=/tmp/t413-plain.pdf; pdf "$PLAIN" "$F"
in_pdf "Zwischensumme" "$F" "Zwischensumme (Netto):"
in_pdf "USt 19 %" "$F" "USt 19 %:"
in_pdf "Gesamtbetrag 1.190,00" "$F" "1.190,00"
not_in_pdf "no Rabatt row" "$F" "Rabatt"
assert_eq "one page" "$(python3 -c "
import re
d = open('$F','rb').read()
m = re.search(rb'/Type /Pages[^>]*?/Count (\d+)', d, re.S) or re.search(rb'/Count (\d+)', d)
print(int(m.group(1)) if m else -1)")" "1"

note "=== 5. the API figures are unchanged ==="
AS GET "/api/v1/invoices/$DISC?companyId=$C"
assert_eq "total 1071" "$(json_field "$BODY" total)" "1071"
assert_eq "totalVat 171" "$(json_field "$BODY" totalVat)" "171"
assert_eq "subtotal still the undiscounted line sum" "$(json_field "$BODY" subtotal)" "1000"

summary; exit $?
