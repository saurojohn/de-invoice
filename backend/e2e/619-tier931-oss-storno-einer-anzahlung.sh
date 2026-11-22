#!/bin/bash
# Tier 931 — a prepaid shop order to a consumer abroad, cancelled before shipping
#
# Tier 922 declares a payment received before the supply in the OSS quarter
# of the payment; Tier 923 put the credit note of a sale not yet supplied at
# the supply. Measured: paid today, shipped next quarter, cancelled today — OSS
# this quarter +200 €, next quarter −200 € (a negative line of France). The
# part paid is corrected in the credit note's quarter, as in the UStVA (Tier
# 924); nothing is left for the quarter of a supply that will not come.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-619-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; Q=$(( (10#${TODAY:5:2} - 1) / 3 + 1 ))
read -r NQY NQ NEXTQ < <(python3 -c "
y,q=$Y,$Q
ny,nq=(y+1,1) if q==4 else (y,q+1)
print(ny, nq, f'{ny}-{(nq-1)*3+1:02d}-02')")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier931-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH in the OSS scheme" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","ossVerfahren":true}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont 619","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
K=$(json_field "$BODY" id)
order() { # net [paid gross]
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NEXTQ\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.2}]}"
  ORDER=$(json_field "$BODY" id); local id=$ORDER
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  [ -n "${2:-}" ] && AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
}
ossVat() { AS GET "/api/v1/reports/oss?companyId=$C&year=$1&quarter=$2"; python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(round(d['totals']['vatAmount'] + sum(c['vat'] for c in d.get('corrections', [])), 2))" "$BODY"; }

note "=== an order paid today, to be shipped on $NEXTQ, cancelled today ==="
order 1000 1200
assert_eq "paid at once" "$STATUS" "201"
AS POST "/api/v1/invoices/$ORDER/credit-note?companyId=$C" '{}'
assert_eq "cancelled" "$STATUS" "201"
assert_eq "OSS $Y-Q$Q: 0 (was +200)" "$(ossVat $Y $Q)" "0"
assert_eq "OSS $NQY-Q$NQ: 0 (was −200)" "$(ossVat $NQY $NQ)" "0"

summary
