#!/bin/bash
# Tier 965 — an overpayment entered after the year end
#
# The balance sheet's customer credit (4500) took the credit ledger by the
# moment a row was typed in. A payment of 20.12.2025 entered in 2026: its
# overpayment was a debt of 31.12.2026 only — at 31.12.2025 the money was in
# the bank and the equity 210 € too high (§ 252 Abs. 1 Nr. 3 HGB).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-652-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier965-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-11-10\",\"deliveryDate\":\"2025-11-10\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":1400,"paymentDate":"2025-12-20","paymentMethod":"bank_transfer"}'
assert_eq "1 190 € invoiced, 1 400 € received on 20.12.2025 — entered today" "$STATUS" "201"
credit() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$1"; P "round(sum(float(l['amount'] or 0) for g in d['passiva'] for l in g['lines'] if l['position'] == '4500'), 2)"; }
assert_eq "31.12.2025: the 210 € overpaid are owed to the customer (was 0)" "$(credit 2025)" "210.0"
assert_eq "31.12.2026: still owed" "$(credit 2026)" "210.0"

summary
