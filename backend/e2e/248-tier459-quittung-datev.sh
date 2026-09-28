#!/bin/bash
# Tier 459 — the payment of a Quittung reaches DATEV
#
# Since Tier 424 a Quittung (RCV) is a sale of its own: DATEV books it on the
# customer's Debitor like an invoice. Its payment did not follow — the
# payments query took invoices and credit notes only (type INV / CN). Measured
# before, a Quittung over 119 € paid 119 € by bank:
#   - DATEV: the Debitor left at 119 € owed, the bank at 0
#   - and the app itself left it "sent": PaymentService set only an INV paid
#     (the comment said INV / RCV) — nor back to open when the payment was
#     deleted
# Now the payments of every document a customer can owe money on (INV, RCV)
# are exported.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-248-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier459-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"RCV\",\"issueDate\":\"2026-06-10\",\"items\":[{\"description\":\"Verkauf\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
R=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$R/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$R/payments?companyId=$C" '{"amount":119,"paymentDate":"2026-06-10","paymentMethod":"bank_transfer"}'
assert_eq "fixture: the Quittung paid" "$STATUS" "201"
P=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$R?companyId=$C"
assert_eq "…and settled in the app (was 'sent': only an INV was set paid)" "$(json_field "$BODY" status)" "paid"

curl -sS -o /tmp/t459.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-06-01&endDate=2026-06-30"
DEB=$(datev_rows /tmp/t459.csv | awk -F'\t' '$1 ~ /^RCV-/ && $2 == "" {print $3; exit}')
[[ -n "$DEB" ]] && pass "DATEV: the Quittung on Debitor $DEB" || fail "no Quittung row"
assert_eq "DATEV: the Debitor settled (was 119 owed)" "$(datev_balance /tmp/t459.csv "$DEB")" "0.00"
assert_eq "…the money on the bank (was 0)" "$(datev_balance /tmp/t459.csv 1200)" "119.00"

note "=== the payment taken back ==="
AS DELETE "/api/v1/invoices/$R/payments/$P?companyId=$C"
assert_eq "deleted" "$STATUS" "200"
AS GET "/api/v1/invoices/$R?companyId=$C"
assert_eq "the Quittung is open again" "$(json_field "$BODY" status)" "sent"

summary
