#!/bin/bash
# Tier 483 — the VAT in the EÜR
#
# § 4 Abs. 3 EStG counts money: the VAT received with the income, the input
# tax paid and the VAT paid to / refunded by the Finanzamt are Betriebs-
# einnahmen / -ausgaben (Anlage EÜR Zeilen 17, 18, 57, 58). Measured before:
# the EÜR, Anlage S / V / G had none of these lines — net only — and there
# was no way to record the payment of a UStVA (PUT …/payment 404), so e.g.
# December's VAT paid in January could not move profit between years.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-269-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier483-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
line() { P "[l['amount'] for l in d['$1'] if l['kennziffer']=='$2'][0]"; }
file_return() { # year month [status] → filing id (submitted by default)
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"
  AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']=sys.argv[2];print(json.dumps(d))" "$BODY" "${3:-submitted}")"
  json_field "$BODY" id
}

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-12-01\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":1190,"paymentDate":"2025-12-10","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Material","invoiceDate":"2025-12-05","paidAt":"2025-12-12","netAmount":500,"vatRate":0.19,"vatAmount":95,"grossAmount":595}'
assert_eq "fixture: 1 190 received, 595 paid in December 2025" "$STATUS" "201"

note "=== EÜR 2025: the VAT with the money ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "4140 vereinnahmte USt 190 (was: no line)" "$(line einnahmen 4140)" "190"
assert_eq "5850 gezahlte Vorsteuer 95 (was: no line)" "$(line ausgaben 5850)" "95"
assert_eq "Gewinn 1000 - 500 + 190 - 95 = 595 (was 500)" "$(P "d['totals']['gewinn']")" "595"
EUER25=$(P "d['totals']['gewinn']")
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2025"
assert_eq "Anlage S: the same profit" "$(P "d['totals']['gewinn']")" "$EUER25"

note "=== the December return, paid in January ==="
DRAFT=$(file_return 2025 11 draft)
AS PUT "/api/v1/ustva/filings/$DRAFT/payment?companyId=$C" '{"paidAt":"2025-12-10"}'
assert_eq "a draft return takes no payment" "$STATUS" "400"
F=$(file_return 2025 12)
AS PUT "/api/v1/ustva/filings/$F/payment?companyId=$C" '{"paidAt":"2026-01-10"}'
assert_eq "payment recorded (was 404)" "$STATUS" "200"
assert_eq "…the Differenzbetrag 95 by default" "$(P "d['paidAmount']")" "95"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "EÜR 2025 unchanged — the money left in 2026" "$(P "d['totals']['gewinn']")" "595"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: 5860 an das Finanzamt gezahlt 95" "$(line ausgaben 5860)" "95"

note "=== a refund ==="
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Maschine","invoiceDate":"2026-02-05","paidAt":"2026-02-06","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190}'
R=$(file_return 2026 2)
AS PUT "/api/v1/ustva/filings/$R/payment?companyId=$C" '{"paidAt":"2026-03-20"}'
assert_eq "Differenz -190: refunded" "$(P "d['paidAmount']")" "-190"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: 4150 vom Finanzamt erstattet 190" "$(line einnahmen 4150)" "190"

note "=== a draft is no return to pay ==="
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "…the November draft stayed unpaid" "$(P "[x['paidAt'] for x in d if x['id']=='$DRAFT']")" "[None]"

summary
