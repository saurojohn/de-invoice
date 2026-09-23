#!/bin/bash
# Tier 439 — KSt 1: no credit of the Gewerbesteuer against the KSt
#
# KSt 1 subtracted min(KSt, 3,8 × GewSt-Messbetrag) from the
# Körperschaftsteuer — the Steuerermäßigung of § 35 EStG, which reduces the
# income tax of natural persons with Gewerbe income and does not apply to a
# Kapitalgesellschaft. Measured at 100 050 € profit, Hebesatz 400: KSt
# 15 007,50 € "after Anrechnung" 1 700,85 €, zu zahlen 16 533,26 €.
# Right: 15 007,50 + Soli 825,41 + GewSt 14 000 (100 000 rounded down to
# full 100 € × 3,5 % × 400 %) = 29 832,91 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-228-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier439-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business"}'
CUST=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CUST'","issueDate":"'$Y'-03-01","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100050,"vatRate":0.19}]}'
INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'

AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"
T() { py "print(d['totals'].get('$1'))"; }
assert_eq "ZvE = Jahresüberschuss" "$(T zve)" "100050"
assert_eq "KSt 15 %" "$(T kst)" "15007.5"
assert_eq "Soli 5,5 % of the KSt" "$(T soli)" "825.41"
assert_eq "GewSt-Messbetrag: 100 000 (rounded down to 100) × 3,5 % (was 3501.75)" "$(T gewstMessbetrag)" "3500"
assert_eq "GewSt × 400 %" "$(T gewst)" "14000"
assert_eq "no KSt-Anrechnung (was 13306.65)" "$(T kstAnrechnung)" "None"
assert_eq "zu zahlen = KSt + Soli + GewSt (was 16533.26)" "$(T zuZahlen)" "29832.91"
curl -sS -o /tmp/t439.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/kst1.pdf?companyId=$C&year=$Y"
assert_eq "PDF still renders" "$(head -c 4 /tmp/t439.pdf)" "%PDF"

summary
