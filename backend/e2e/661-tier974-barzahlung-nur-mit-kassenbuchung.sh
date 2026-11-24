#!/bin/bash
# Tier 974 — a cash payment goes with its cash-book entry
#
# A payment the cash book recorded (a cash receipt for an invoice) could be
# deleted on the invoice alone: the invoice open — and dunned — again, the
# 119 € still in the till and in no report; a second cash receipt then put
# 238 € in the till for one invoice of 119 € (§ 146 Abs. 1 AO).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-661-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days ago' +%F)
D2=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier974-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":100}"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D2\",\"type\":\"einnahme\",\"description\":\"Bar\",\"amount\":119,\"invoiceId\":\"$I\"}"
E=$(json_field "$BODY" id)
P=$(sql "select id from \"Payment\" where \"invoiceId\" = '$I'")
assert_eq "the invoice paid in cash at the counter" "$(sql "select status from \"Invoice\" where id = '$I'")" "paid"
AS DELETE "/api/v1/invoices/$I/payments/$P?companyId=$C"
assert_eq "the payment deleted on the invoice alone: refused, pointing to the cash book (was 200)" \
  "$STATUS/$(echo "$BODY" | grep -c 'Kassenbuch')" "400/1"
assert_eq "…the invoice stays paid" "$(sql "select status from \"Invoice\" where id = '$I'")" "paid"
AS POST "/api/v1/cashbook/entries/$E/reverse?companyId=$C" '{"reason":"falsch kassiert"}'
assert_eq "the cash entry reversed in the cash book: it takes the payment along" \
  "$STATUS/$(sql "select status from \"Invoice\" where id = '$I'")/$(sql "select count(*) from \"Payment\" where \"invoiceId\" = '$I'")" "201/sent/0"

summary
