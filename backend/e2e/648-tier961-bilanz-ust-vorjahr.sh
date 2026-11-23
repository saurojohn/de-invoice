#!/bin/bash
# Tier 961 — the VAT of an earlier year in the balance sheet
#
# The balance sheet's VAT balance (4600 owed / 1800 claim) took the year's
# own returns only. What was still open at the end of the year before — a
# December return not paid yet — was gone from the next balance sheet: the
# opening equity did not match the closing one (§ 252 Abs. 1 Nr. 1 HGB,
# Bilanzidentität). Measured: 4600 3 800 € instead of 11 400 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-648-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier961-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader with a balance sheet" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"bilanz"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-12-10\",\"deliveryDate\":\"2025-12-10\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":11900,"paymentDate":"2025-12-20","paymentMethod":"bank_transfer"}'
assert_eq "December 2025: 10 000 € + 1 900 € VAT, received" "$STATUS" "201"
bil() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$1"; P "(round(sum(float(l['amount'] or 0) for g in d['passiva'] for l in g['lines'] if l['position'] == '4600'), 2), float(d['totals']['eigenkapital']))"; }
B25=$(bil 2025)
assert_eq "31.12.2025: 1 900 € VAT owed" "${B25%%,*}" "(1900.0"
assert_eq "31.12.2026 (nothing paid, nothing else happened): the same VAT owed and the same equity (was 0 € owed, the equity 1 900 € higher)" "$(bil 2026)" "$B25"

summary
