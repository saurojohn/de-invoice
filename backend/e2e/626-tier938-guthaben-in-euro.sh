#!/bin/bash
# Tier 938 — a customer's credit is in euros, whatever the invoice's currency
#
# The credit ledger (CustomerCreditTransaction) holds EUR. Measured: a JPY
# invoice (119 000 JPY = 743,75 €) paid with 129 000 JPY (806,25 €) — the
# 10 000 JPY overpaid became a credit of 10 000 €; applied to a EUR invoice
# it settled 10 000 € of it (the EÜR: 10 743,75 € received for 806,25 €),
# and it could have been paid out as 10 000 €. The overage is converted at
# the payment's rate (62,50 €); credit applied to an invoice in another
# currency is converted into that currency.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-626-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier938-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Tokyo KK 626","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
inv() { # net extra
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]${2:+,$2}}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
credit() { AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"; P "d['balance']"; }

note "=== a JPY invoice overpaid by 10 000 JPY ==="
inv 100000 '"currency":"JPY","exchangeRate":160'; J1=$I
AS POST "/api/v1/invoices/$J1/payments?companyId=$C" "{\"amount\":129000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"eurAmount\":806.25}"
assert_eq "paid 129 000 JPY (806,25 €)" "$STATUS" "201"
assert_eq "the credit: 62,50 € (was 10 000 €)" "$(credit)" "62.5"

note "=== the credit applied ==="
inv 100; E=$I
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$E\",\"amount\":10000}"
assert_eq "10 000 € of it: refused, there are 62,50" "$STATUS" "400"
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$E\",\"amount\":30}"
assert_eq "30 € on a EUR invoice" "$STATUS/$(q "select amount from \"Payment\" where \"invoiceId\"='$E' and \"paymentMethod\"='Guthaben'")" "201/30.0000"
inv 10000 '"currency":"JPY","exchangeRate":160'; J2=$I
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$J2\",\"amount\":32.5}"
assert_eq "the rest, 32,50 €, on a JPY invoice: 5 200 JPY, worth 32,50 € (was booked as 32,50 JPY)" \
  "$STATUS/$(q "select amount||'/'||\"eurAmount\" from \"Payment\" where \"invoiceId\"='$J2' and \"paymentMethod\"='Guthaben'")" "201/5200.0000/32.50"
assert_eq "…the credit used up" "$(credit)" "0"

summary
