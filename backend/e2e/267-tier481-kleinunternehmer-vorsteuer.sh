#!/bin/bash
# Tier 481 — a Kleinunternehmer deducts no input tax
#
# § 19 Abs. 1 Satz 4 UStG. Measured before, for a company with defaultVatMode
# 'kleinunternehmer': one purchase of 1 000 + 190 → UStVA Vorsteuer 190,
# Differenzbetrag -190 — a refund the company is not entitled to. (The EÜR
# already counted the gross 1 190 as cost.) The tax a Kleinunternehmer owes
# on a § 13b purchase stays owed, without the deduction.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-267-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier481-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Laptop","invoiceDate":"2026-09-10","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190}'
assert_eq "fixture: a purchase 1 000 + 190" "$STATUS" "201"

AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
assert_eq "no input tax, nothing to refund (was Vorsteuer 190, Differenz -190)" \
  "$(P "'%g/%g' % (d['vorsteuerSum'], d['differenzbetrag'])")" "0/0"

AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Montage (§ 13b)","invoiceDate":"2026-09-11","netAmount":500,"vatRate":0.19,"vatAmount":0,"grossAmount":500,"isReverseCharge":true}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
assert_eq "§ 13b: the tax 95 is owed, not deducted (payable 95)" \
  "$(P "'%g/%g/%g' % (d['umsatzsteuer'], d['vorsteuerSum'], d['differenzbetrag'])")" "95/0/95"

summary
