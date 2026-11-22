#!/bin/bash
# Tier 922 — Mindest-Ist in the OSS return
#
# Tier 921 put a Vorausrechnung into the period of its supply and declared a
# payment received before it when received — in the UStVA. The OSS return
# took the invoice with its supply quarter only: a web shop's order paid at
# once and shipped after the quarter's end moved, tax and all, into the next
# quarter (it had been in the quarter of the invoice until Tier 921).
# § 13 Abs. 1 Nr. 1 a Satz 4 UStG applies to the OSS sales as well.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-610-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; Q=$(( (10#${TODAY:5:2} - 1) / 3 + 1 ))
read -r NQY NQ NEXTQ < <(python3 -c "
y,q=$Y,$Q
ny,nq=(y+1,1) if q==4 else (y,q+1)
print(ny, nq, f'{ny}-{(nq-1)*3+1:02d}-02')")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier922-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH in the OSS scheme" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","ossVerfahren":true}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont 610","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
K=$(json_field "$BODY" id)
order() { # net [paid gross]
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NEXTQ\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.2}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  [ -n "${2:-}" ] && AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
}
ossVat() { AS GET "/api/v1/reports/oss?companyId=$C&year=$1&quarter=$2"; python3 -c "import sys,json;print(round(json.loads(sys.argv[1])['totals']['vatAmount'],2))" "$BODY"; }

note "=== orders of today, shipped on $NEXTQ ==="
order 1000 1200
assert_eq "one paid at once" "$STATUS" "201"
order 500
assert_eq "OSS $Y-Q$Q: the 200 € of the paid order (was 0)" "$(ossVat $Y $Q)" "200"
assert_eq "OSS $NQY-Q$NQ: only the unpaid order's 100 € (was 300)" "$(ossVat $NQY $NQ)" "100"

summary
