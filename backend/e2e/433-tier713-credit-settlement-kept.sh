#!/bin/bash
# Tier 713 — a credit note's settlement against its invoice is not deleted
#
# A credit note books a payment „Gutschrift“ on the invoice it corrects; the
# invoice page offered „Löschen“ on it, and the API took it. Measured: the
# payment deleted, the credit note stayed issued at −119 € (in the UStVA, the
# EÜR, DATEV) and its invoice was open for the full 1 190 € again — and dunned
# for it. A settled credit note cannot be cancelled either (Tier 461): the
# settlement stays. A bank payment beside it is deleted as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-433-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier713-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"dueDate\":\"2026-11-30\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
assert_eq "fixture: a credit note over 119 €" "$STATUS" "201"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":100,"paymentDate":"2026-10-10","paymentMethod":"bank_transfer"}'
BANK=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$I/payments?companyId=$C"
SETTLE=$(P "[p['id'] for p in d if p['paymentMethod'] == 'Gutschrift'][0]")
[[ -n "$SETTLE" ]] && pass "fixture: its settlement on the invoice" || fail "no settlement payment"

AS DELETE "/api/v1/invoices/$I/payments/$SETTLE?companyId=$C"
assert_eq "the settlement is not deleted (was: 200)" "$STATUS" "400"
assert_eq "…the answer names the credit note" "$(P "'Gutschrift CN-' in d['message'] and 'neue Rechnung' in d['message']")" "True"
assert_eq "…it is still there; the invoice still open for 1 190 − 119 − 100 = 971 €" \
  "$(q "select count(*) from \"Payment\" where id='$SETTLE'")/$(q "select (\"total\" - (select sum(amount) from \"Payment\" where \"invoiceId\"='$I'))::numeric(12,2) from \"Invoice\" where id='$I'")" "1/971.00"
AS DELETE "/api/v1/invoices/$I/payments/$BANK?companyId=$C"
assert_eq "a bank payment beside it: deleted as before" "$STATUS/$(q "select count(*) from \"Payment\" where id='$BANK'")" "200/0"

summary
