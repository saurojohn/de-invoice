#!/bin/bash
# Tier 902 — the euros received belong to the amount paid
#
# Measured: a payment of 100 USD on an invoice at 1,1 USD / € (90,91 €) entered
# with 100 000 € received was recorded, and the EÜR counted 100 000 € of
# income (`eurAmount`, Tier 540). A rate that moved, a bank's fee or margin
# stay well inside a factor of 5 either way; a slipped decimal point does not.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-590-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier902-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
q="companyId=$C"
CUST='{"name":"Boston 590 Inc.","type":"business","address":{"street":"Main St 1","city":"Boston","postalCode":"02108","country":"US"}}'
AS POST "/api/v1/customers?$q" "$CUST"; K=$(field id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"currency\":\"USD\",\"exchangeRate\":1.1,\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":1100,\"vatRate\":0}]}"
AS POST "/api/v1/invoices?$q" "$INV"; I=$(field id)
AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
assert_eq "fixture: a 1 100 USD invoice at 1,1 USD / €, issued" "$STATUS" "200"
# pay EUR [USD] — a payment of USD (100) with EUR received
pay() { AS POST "/api/v1/invoices/$I/payments?$q" "{\"amount\":${2:-100},\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"eurAmount\":$1}"; }
gewinn() { curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/euer?$q&year=$Y" | python3 -c "import sys,json;print(json.load(sys.stdin)['totals']['gewinn'])"; }
EUER0=$(gewinn)

pay 100000
assert_eq "100 USD received as 100 000 €: refused (was: 100 000 € income in the EÜR)" "$STATUS" "400"
assert_contains "…says what the invoice's rate gives" "$BODY" "wären es 90,91 €"
pay 9.09
assert_eq "…as 9,09 € (a decimal point too far): refused" "$STATUS" "400"
pay 85.5
assert_eq "…as 85,50 € (a rate that moved, a fee): recorded" "$STATUS" "201"
pay 120 110
assert_eq "110 USD received as 120,00 €: recorded" "$STATUS" "201"
AS POST "/api/v1/invoices/$I/payments?$q" "{\"amount\":121,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "121 USD without the euros (at the invoice's rate, 110 €): recorded" "$STATUS" "201"
EUER1=$(gewinn)
assert_eq "the EÜR's Gewinn grows by 85,50 + 120 + 110 € — what arrived, nothing of the refused" "$(python3 -c "print(round($EUER1 - $EUER0, 2))")" "315.5"

summary
