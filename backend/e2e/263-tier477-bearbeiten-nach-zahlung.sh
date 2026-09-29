#!/bin/bash
# Tier 477 — no editing once money or a correction is booked
#
# HANDOFF §9 item 14, user decision: a sent invoice stays editable on its
# issue day, but not once a payment or a credit note is booked on it.
# Measured before (same-day invoices):
#   paid 1 190 €, edited to 2 000 net → 200, total 2 380, status still "paid"
#     with 1 190 € received
#   119 € credit note, edited to 50 net → 200, the invoice (59,50 €) now
#     smaller than its credit note
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-263-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier477-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
sent() { # net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
edit() { AS PUT "/api/v1/invoices/$1?companyId=$C" "{\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"; }

PAID=$(sent 1000)
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
edit "$PAID" 2000
assert_eq "a paid invoice cannot be edited (was 200)" "$STATUS" "403"
AS GET "/api/v1/invoices/$PAID?companyId=$C"
assert_eq "…and keeps its amount (was 2380)" "$(json_field "$BODY" total)" "1190"

CREDITED=$(sent 1000)
AS POST "/api/v1/invoices/$CREDITED/credit-note?companyId=$C" '{"amount":119}'
edit "$CREDITED" 50
assert_eq "a credited invoice cannot be edited (was 200)" "$STATUS" "403"

OPEN=$(sent 1000)
edit "$OPEN" 900
assert_eq "an unpaid invoice of today still can" "$STATUS" "200"
AS GET "/api/v1/invoices/$OPEN?companyId=$C"
assert_eq "…to 1071" "$(json_field "$BODY" total)" "1071"

summary
