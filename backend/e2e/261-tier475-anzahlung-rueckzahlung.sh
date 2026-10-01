#!/bin/bash
# Tier 475 — an advance paid back
#
# The order behind a paid Proforma falls through and the money goes back.
# Measured before: the Proforma could not be cancelled (400, it has a
# payment), a negative payment was refused (400) and there was no refund
# endpoint (404) — the only way out was deleting the payment, which took the
# advance and its 190 € tax out of 12/2025, the month it was received and
# possibly filed. Now the refund is booked in the month it is paid
# (§ 17 Abs. 2 Nr. 2 UStG, § 11 EStG); December stays as it was.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-261-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier475-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
vat19() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9] or [(0, 0)]"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Teststr. 9\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"}}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"2025-12-01\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":1190,"paymentDate":"2025-12-10","paymentMethod":"bank_transfer"}'
assert_eq "fixture: Proforma paid 1 190 on 10.12.2025" "$STATUS" "201"

AS POST "/api/v1/invoices/$PI/advance-refund?companyId=$C" '{"amount":1200,"paymentDate":"2026-02-10","paymentMethod":"bank_transfer"}'
assert_eq "no more than was received" "$STATUS" "400"
AS POST "/api/v1/invoices/$PI/advance-refund?companyId=$C" '{"amount":1190,"paymentDate":"2026-02-10","paymentMethod":"bank_transfer"}'
assert_eq "refund booked (was 404)" "$STATUS" "201"
assert_eq "…as a negative payment on the Proforma" "$(P "float(d['amount'])")" "-1190.0"

note "=== VAT ==="
assert_eq "12/2025 stays as filed: 1000 / 190" "$(vat19 2025 12)" "[(1000, 190)]"
assert_eq "02/2026: the refund, -1000 / -190" "$(vat19 2026 2)" "[(-1000, -190)]"

note "=== income ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "EÜR 2025: 1000" "$(P "[l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'][0]")" "1000"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: -1000" "$(P "[l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'][0]")" "-1000"

note "=== DATEV: erhaltene Anzahlungen an Bank ==="
curl -sS -o /tmp/t475.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-02-01&endDate=2026-02-28"
assert_eq "one row 1200 / 1718, 1190, H (money out of the bank)" \
  "$(datev_rows /tmp/t475.csv | awk -F'\t' '{print $3":"$4":"$5":"$6}' | tr '\n' ' ')" "1200:1718:1190.00:H "

note "=== Bilanz ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2025"
assert_eq "31.12.2025: 4200 owes 1190" "$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")" "1190"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2026"
assert_eq "31.12.2026: nothing owed" "$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")" "0"

note "=== Ist-Versteuerung ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
assert_eq "Ist 12/2025: 1000 / 190" "$(vat19 2025 12)" "[(1000, 190)]"
assert_eq "Ist 02/2026: -1000 / -190" "$(vat19 2026 2)" "[(-1000, -190)]"

AS POST "/api/v1/invoices/$PI/advance-refund?companyId=$C" '{"amount":1,"paymentDate":"2026-02-11","paymentMethod":"bank_transfer"}'
assert_eq "nothing left to refund" "$STATUS" "400"

summary
