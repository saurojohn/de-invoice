#!/bin/bash
# Tier 505 — a bank receipt in EUR on a foreign-currency invoice
#
# A payment's amount is in the invoice's currency (DATEV and the EÜR convert
# it at the invoice's rate). Measured before: matching a EUR bank credit to a
# USD invoice booked the EUR figure as if it were USD — 1 000 € received for
# a 1 085 USD invoice (= 1 000 € at its rate) became a payment of "1 000 USD",
# the invoice stayed open for 85 USD, the EÜR / DATEV counted 921,66 €.
#
# Now the EUR amount is converted at the invoice's rate; within 2 % of what is
# open (the rate moved between invoice and payment) it settles the invoice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-291-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier505-e2e\",\"companyName\":\"$TAG Export\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/exchange-rates/refresh" "{\"companyId\":\"$C\"}"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Inc\",\"type\":\"business\",\"address\":{\"street\":\"1 Main St\",\"postalCode\":\"10001\",\"city\":\"New York\",\"country\":\"US\"}}"
K=$(json_field "$BODY" id)
usd() { # → id of a sent 1 085 USD invoice
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"currency\":\"USD\",\"items\":[{\"description\":\"Software\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1085,\"vatRate\":0}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
A=$(usd); B=$(usd); D=$(usd)
assert_eq "fixture: 1 085 USD = 1 000 € at the invoice's rate" "$(q "select \"eurTotal\"::numeric(12,2) from \"Invoice\" where id='$A'")" "1000.00"

MT=/tmp/t505-$TAG.mt940
cat > "$MT" <<'MT'
:1:F01BANKBICAXXX0000000000
:20:ST505
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR0,00
:61:2606100610C1000,00NTRFNONREF//Zahlung A
Kunde
:86:166?00GUTSCHRIFT?20Zahlung A
:61:2606110611C990,00NTRFNONREF//Zahlung B
Kunde
:86:166?00GUTSCHRIFT?20Zahlung B
:61:2606120612C500,00NTRFNONREF//Zahlung D
Kunde
:86:166?00GUTSCHRIFT?20Zahlung D
:62F:C260612EUR2490,00
-
MT
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
txn() { echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==$1][0])"; }
match() { AS POST "/api/v1/bank-statements/$SID/transactions/$(txn "$1")/match?companyId=$C" "{\"invoiceId\":\"$2\"}"; }
paid() { q "select coalesce(sum(amount),0)::numeric(12,2)||'/'||(select status from \"Invoice\" where id='$1') from \"Payment\" where \"invoiceId\"='$1'"; }

note "=== 1 000 € for 1 085 USD ==="
match 1000 "$A"
assert_eq "matched" "$STATUS" "201"
assert_eq "a payment of 1 085 USD — the invoice is paid (was 1 000 'USD', open 85)" "$(paid "$A")" "1085.00/paid"

note "=== 990 €: the rate moved by 1 % ==="
match 990 "$B"
assert_eq "it settles the invoice (within 2 %)" "$(paid "$B")" "1085.00/paid"

note "=== 500 €: a partial payment ==="
match 500 "$D"
assert_eq "500 € at the invoice's rate = 542,50 USD, the rest stays open" "$(paid "$D")" "542.50/sent"

rm -f "$MT"
summary
