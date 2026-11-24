#!/bin/bash
# Tier 968 — a foreign-currency final invoice in the UStVA
#
# A Soll company: a USD Proforma of 10 000 + 19 % at 1,25 USD/€, 5 950 USD
# received (taxed then: 4 000 / 760 € — § 13 Abs. 1 Nr. 1 a Satz 4, § 16
# Abs. 6 UStG); the final invoice at 1,10 (measured; here the rate of its day). The UStVA declared the whole
# delivery at 1,10 (9 090,91 €) and took the advance off at the Proforma's
# 1,25 (4 000 €): 5 090,91 € in Kz 81, 545,45 € too much — the rest is
# 5 000 USD at 1,10 = 4 545,45 €, as the EÜR counts it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-655-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier968-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"; P "round(float({k['kz']: k['value'] for k in d['kennzahlen']}.get('81') or 0), 2)"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"US Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"type\":\"PI\",\"customerId\":\"$K\",\"issueDate\":\"2026-09-02\",\"deliveryDate\":\"2026-11-20\",\"currency\":\"USD\",\"exchangeRate\":1.25,\"items\":[{\"description\":\"Anlage\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":5950,"paymentDate":"2026-09-05","paymentMethod":"bank_transfer","eurAmount":4760}'
assert_eq "September: the advance, 5 000 USD at 1,25 = 4 000 €" "$(kz81 9)" "4000.0"
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" '{"issueDate":"2026-11-20"}'
FI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$FI/status?companyId=$C" '{"status":"sent"}'
assert_eq "the final invoice issued (at the rate of its day)" "$STATUS" "200"
AS GET "/api/v1/invoices/$FI?companyId=$C"
REST=$(P "round(float(d['eurSubtotal']) / 2, 2)")
OLD=$(P "round(float(d['eurSubtotal']) - 4000, 2)")
assert_eq "November: the rest, 5 000 USD at the final invoice's rate (was the whole at it less 4 000 € at the Proforma's: $OLD)" "$(kz81 11)" "$REST"

summary
