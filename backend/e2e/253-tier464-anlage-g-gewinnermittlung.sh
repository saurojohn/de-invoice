#!/bin/bash
# Tier 464 — Anlage G follows the company's Gewinnermittlung
#
# Measured before, a sole trader with an invoice of November 2025 (1 000 €
# net) paid in January 2026 and a cash sale in December 2025 (100 € net):
# Anlage G 2025 income 1 000 (the EÜR 100), 2026 income 0 (the EÜR 1 000) —
# Anlage G counted by document date for everyone, and the Kassenbuch's cash
# sales and purchases were in no Anlage G.
#
# Now an EÜR company (the default for a sole trader, freelancer, GbR, PartG)
# counts when paid, as its EÜR; a balance-sheet company (OHG, KG, GmbH & Co.
# KG, corporations — or set so) by document date. Both include the cash book.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-253-$(date +%s%N | cut -c1-13)"

company() { # name
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$(echo "$1" | tr ' ' '-')@example.test\",\"password\":\"Tier464-e2e\",\"companyName\":\"$1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
# Tier 483: with an EÜR, Anlage G and the EÜR add the VAT in the cash flows
# (2195 / 2895, 4140 / 4150 / 5850 / 5860); this spec is about which revenue
# and costs count, so it compares the net lines.
g() { AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$1"; py "x=('2195','2895');i=sum(l['amount'] for l in d['einnahmen'] if l['kennziffer'] not in x);a=sum(l['amount'] for l in d['betriebsausgaben'] if l['kennziffer'] not in x);print(d['gewinnermittlung'], '%g' % round(i,2), '%g' % round(i+a,2))"; }
euer() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$1"; py "x=('4140','4150','5850','5860');print('%g' % round(sum(l['amount'] for l in d['einnahmen'] if l['kennziffer'] not in x)-sum(l['amount'] for l in d['ausgaben'] if l['kennziffer'] not in x),2))"; }

company "$TAG Handel"
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
CUST=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CUST'","issueDate":"2025-11-10","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-01-15","paymentMethod":"bank"}'
assert_eq "the invoice of 2025, paid 2026" "$STATUS" "201"
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"invoiceNumber":"ER-1","description":"Material","invoiceDate":"2025-12-20","netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238,"paidAt":"2026-01-05"}'
assert_eq "a bill of December 2025, paid January 2026" "$STATUS" "201"
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2025-12-01","type":"einnahme","description":"Barverkauf","amount":119,"vatRate":0.19}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2025-12-10","type":"ausgabe","description":"Barkauf","amount":59.5,"vatRate":0.19}'
assert_eq "a cash sale of 100 and a cash purchase of 50 (net)" "$STATUS" "201"

note "=== a sole trader: EÜR, counted when paid ==="
assert_eq "2025: cash sale only (was 1000 and no cash book)" "$(g 2025)" "euer 100 50"
assert_eq "… as the EÜR" "$(euer 2025)" "50"
assert_eq "2026: the payment and the paid bill (was 0)" "$(g 2026)" "euer 1000 800"
assert_eq "… as the EÜR" "$(euer 2026)" "800"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "derived from the legal form" "$(py 'print(d["gewinnermittlungQuelle"])')" "rechtsform"

note "=== set to Bilanz: by document date ==="
AS PUT "/api/v1/companies/$C" '{"gewinnermittlung":"bilanz"}'
assert_eq "setting accepted" "$STATUS" "200"
assert_eq "2025: invoice + cash sale - bill - cash purchase" "$(g 2025)" "bilanz 1100 850"
assert_eq "2026: nothing dated in 2026" "$(g 2026)" "bilanz 0 0"
AS PUT "/api/v1/companies/$C" '{"gewinnermittlung":"cash"}'
assert_eq "unknown value refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C" '{"gewinnermittlung":null}'
assert_eq "cleared: back to EÜR" "$(g 2025)" "euer 100 50"

note "=== an OHG: Bilanz without being set ==="
company "$TAG Handel OHG"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "an OHG keeps books (§ 238 HGB)" "$(py 'print(d["gewinnermittlung"], d["gewinnermittlungQuelle"])')" "bilanz rechtsform"

summary
