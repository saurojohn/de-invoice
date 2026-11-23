#!/bin/bash
# Tier 951 — the Skonto after a credit note
#
# A payment inside the Skonto window that leaves exactly the discount open
# settles the invoice (Tier 422). The discount was taken on the invoice's
# total: after a credit note (goods returned) the customer pays what is left
# less the Skonto on it — 1 190 € invoice, 595 € credited, 583,10 € paid
# (595 less 2 %): 11,90 € stayed open and were dunned; 23,80 € was "expected".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-638-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier951-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
invoice() { # → I: 1 000 net, 2 % Skonto within 14 days, dated today
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$TODAY\",\"skontoPercent\":2,\"skontoDays\":14,\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
state() { AS GET "/api/v1/invoices/$I?companyId=$C"; P "(d['status'], round(float(d['total']) - sum(float(p['amount']) for p in d['payments']), 2))"; }

invoice
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":595,"reason":"Rücksendung"}'
assert_eq "1 190 € invoice, 595 € credited for goods returned" "${STATUS:0:2}" "20"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":583.10,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "583,10 € paid (595 less 2 %): settled with the Skonto (was 11,90 € open, dunned)" "$(state)" "('paid', 0.0)"
AS GET "/api/v1/invoices?companyId=$C&type=CN"
assert_eq "…the Skonto credit note is 11,90 €" \
  "$(P "sorted(abs(float(x['total'])) for x in (d['data'] if isinstance(d, dict) else d) if x.get('referenceInvoiceId') == '$I')")" "[11.9, 595.0]"

note "=== the discount on the full amount after a credit note is not the customer's ==="
invoice
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":595,"reason":"Rücksendung"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":571.20,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "571,20 € paid (595 less 23,80 €): 23,80 € stay open" "$(state)" "('sent', 23.8)"

summary
