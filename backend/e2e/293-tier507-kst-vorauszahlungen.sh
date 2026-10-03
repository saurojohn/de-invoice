#!/bin/bash
# Tier 507 — KSt prepayments
#
# The Steuerrückstellung (Tier 506) is the year's income taxes less what was
# prepaid. GewSt prepayments could be recorded; KSt (+ Soli) prepayments —
# four quarterly payments on the Vorauszahlungsbescheid — could not
# (PUT /accounting/kst1/vorauszahlungen 404): the Rückstellung counted the
# whole KSt as still owed.
#
# Fixture as spec 292: a GmbH, 10 000 € profit in 2025 → KSt 1 500, Soli
# 82,50, GewSt 1 400 = 2 982,50.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-293-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier507-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-06-02\",\"items\":[{\"description\":\"Projekt\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
B() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2025"; P "[None if l['amount'] is None else float(l['amount']) for s in d['$1'] for l in s['lines'] if l['position']=='$2'][0]"; }
kst() { AS GET "/api/v1/accounting/kst1?companyId=$C&year=2025"; P "(float(d['totals']['vorauszahlungen']), float(d['totals']['verbleibend']))"; }

note "=== recording them ==="
AS PUT "/api/v1/accounting/kst1/vorauszahlungen?companyId=$C" '{"year":2025,"q1":300,"q2":300,"q3":300,"q4":300}'
assert_eq "KSt prepayments recorded (was 404)" "$STATUS" "200"
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" '{"year":2025,"q1":100,"q2":100,"q3":100,"q4":100}'
assert_eq "KSt 1: prepaid 1 200 + 400 = 1 600, left 1 382,50" "$(kst)" "(1600.0, 1382.5)"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=2025"
assert_eq "…the quarters come back for the form" "$(P "d['kstVorauszahlungen']")" "{'q1': 300, 'q2': 300, 'q3': 300, 'q4': 300}"
assert_eq "Bilanz Steuerrückstellung 1 382,50 (was 2 582,50 — KSt prepayments ignored)" "$(B passiva 3100)" "1382.5"

note "=== prepaid too much: a claim ==="
AS PUT "/api/v1/accounting/kst1/vorauszahlungen?companyId=$C" '{"year":2025,"q1":1000,"q2":1000,"q3":1000,"q4":1000}'
assert_eq "KSt 1: 4 400 prepaid, 1 417,50 to be refunded" "$(kst)" "(4400.0, -1417.5)"
assert_eq "Bilanz: no Rückstellung" "$(B passiva 3100)" "0.0"
assert_eq "…the refund in Sonstige Forderungen" "$(B aktiva 1800)" "1417.5"

summary
