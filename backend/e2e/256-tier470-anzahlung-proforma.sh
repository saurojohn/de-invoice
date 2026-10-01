#!/bin/bash
# Tier 470 — a payment on a Proforma is an advance payment
#
# Measured before, on a Proforma of 1 000 + 19 % issued 2025-12-01 and paid
# in full (1 190) on 2025-12-10: UStVA 12/2025 declared nothing, the EÜR 2025
# had no income, the DATEV export had no row and the Bilanz no liability — the
# money arrived and no report knew of it. Advance payments are taxed in the
# month received (§ 13 Abs. 1 Nr. 1a Satz 4 UStG), are income when received
# (§ 11 EStG) and a liability until the final invoice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-256-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier470-e2e\",\"companyName\":\"$TAG Handel\"}" \
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

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Teststr. 9\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"}}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"2025-12-01\",\"items\":[{\"description\":\"Anzahlung Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":1190,"paymentDate":"2025-12-10","paymentMethod":"bank_transfer"}'
assert_eq "fixture: Proforma 1 190 paid on 10.12.2025" "$STATUS" "201"

note "=== UStVA: taxed in the month received ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
assert_eq "19 %: 1000 / 190 (was nothing)" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9]")" "[(1000, 190)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=11"
assert_eq "…not in the month the Proforma was dated before" "$(P "len(d['salesByRate'])")" "0"

note "=== EÜR: income when received ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "4100 Umsatzerlöse 1000 (was 0)" "$(P "[l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'][0]")" "1000"

note "=== DATEV: Bank an erhaltene Anzahlungen 19 % ==="
curl -sS -o /tmp/t470.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2025-12-01&endDate=2025-12-31"
assert_eq "1200 an 1718, 1190 S, 10.12. (was no row)" \
  "$(datev_rows /tmp/t470.csv | awk -F'\t' '{print $3":"$4":"$5":"$6":"$9}' | tr '\n' ' ')" "1200:1718:1190.00:S:1012 "

note "=== Bilanz: owed to the customer until the final invoice ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2025"
assert_eq "4200 Erhaltene Anzahlungen 1190 (was null)" \
  "$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")" "1190"

note "=== Ist-Versteuerung: the same advance, taxed once ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
assert_eq "19 %: 1000 / 190 (was nothing)" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9]")" "[(1000, 190)]"

summary
