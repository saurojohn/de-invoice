#!/bin/bash
# Tier 948 — a payment deleted after a credit note
#
# A credit note issued while its invoice was paid becomes the customer's
# credit (Tier 58: what it cannot settle). The payment deleted afterwards —
# entered for the wrong invoice, say — left the invoice open for its whole
# amount while the credit stayed: measured, 1 190 € open (and dunned) with
# 595 € of credit, for 595 € owed. The credit note now settles the invoice
# after all: its 'Gutschrift' settlement grows, its credit goes — no receipt
# (an applied credit would be income of today, the credit note's refund part
# staying on its own date).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-635-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier948-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-11-10\",\"deliveryDate\":\"2026-11-10\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-11-12","paymentMethod":"bank_transfer"}'
PAY=$(json_field "$BODY" id)
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":595,"reason":"Mangel"}'
assert_eq "1 190 € paid, then a credit note of 595 €" "${STATUS:0:2}" "20"
open() { AS GET "/api/v1/invoices/$I?companyId=$C"; P "round(float(d['total']) - sum(float(p['amount']) for p in d.get('payments', [])), 2)"; }
credit() { AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"; P "float(d['balance'])"; }
assert_eq "…the invoice was paid: the credit note is the customer's credit" "$(open)/$(credit)" "0.0/595.0"

AS DELETE "/api/v1/invoices/$I/payments/$PAY?companyId=$C"
assert_eq "the payment deleted" "$STATUS/$(P "float(d.get('creditSettled') or 0)")" "200/595.0"
assert_eq "…the invoice owes 595 € (was 1 190 €), no credit left (was 595 €)" "$(open)/$(credit)" "595.0/0.0"
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "…its status: open again" "$(P "d['status'] in ('sent', 'overdue')")" "True"
assert_eq "…settled by the credit note, no payment of credit (no receipt)" \
  "$(P "sorted((p['paymentMethod'], float(p['amount'])) for p in d.get('payments', []))")" "[('Gutschrift', 595.0)]"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: no income, no refund — nothing was paid (was −500 / +500 in two places)" \
  "$(P "float(d['totals'].get('einnahmenTotal', sum(float(e['amount']) for e in d['einnahmen'])))")" "0.0"

summary
