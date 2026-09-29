#!/bin/bash
# Tier 474 — no credit note on a Proforma
#
# A Proforma declares no tax (only what is paid on it, Tier 470). Measured
# before: an unpaid 1 000 + 19 % Proforma credited in full (POST
# …/credit-note {amount: 1190}) → 201, and the UStVA of the month showed
# 19 %: -1 000 / -190 — tax taken off that was never declared.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-260-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier474-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"2026-04-01\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'

AS POST "/api/v1/invoices/$PI/credit-note?companyId=$C" '{"amount":1190}'
assert_eq "credit note on a Proforma refused (was 201)" "$STATUS" "400"
# the credit note is dated today
AS GET "/api/v1/ustva/compute?companyId=$C&year=$(date +%Y)&month=$(date +%-m)"
assert_eq "UStVA of this month untouched (was 19 %: -1000 / -190)" "$(P "d['salesByRate']")" "[]"
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "…an unpaid Proforma is cancelled instead" "$STATUS" "200"

summary
