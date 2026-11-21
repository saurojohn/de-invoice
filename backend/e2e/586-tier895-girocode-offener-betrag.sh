#!/bin/bash
# Tier 895 — the GiroCode pays what is still open
#
# Found after Tier 894: the invoice page's „GiroCode“ (girocode.png) encoded
# the invoice's total after a payment too — 1 190 € for an invoice of which
# 190 € were paid: a scan overpays by what came in. A paid invoice still got
# a code for its full total.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-586-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier895-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Commerzbank\"}'::jsonb where id='$C'" >/dev/null
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Code 586 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(field id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
code() { curl -sS -o /dev/null -D - "$API/api/v1/invoices/$I/girocode.png?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" | tr -d '\r' | awk 'NR==1{s=$2} tolower($1)=="x-girocode-amount:"{a=$2} END{print s" "a}'; }

assert_eq "open: the total" "$(code)" "200 1190.00"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "190 paid: what is open (was: 1190.00)" "$(code)" "200 1000.00"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":1000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "paid: no code (was: 1190.00)" "$(code)" "400 "
summary
