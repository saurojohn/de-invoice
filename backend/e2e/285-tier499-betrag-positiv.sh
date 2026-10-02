#!/bin/bash
# Tier 499 — an invoice's total is above 0
#
# Measured before: POST /invoices took an INV of −595 € (a line of −500 €)
# and one of 0 €, and both could be issued. A negative "invoice" is a credit
# note without the invoice it corrects (§ 31 Abs. 5 UStDV) — it went into
# the UStVA and the EÜR as negative revenue —, a 0 € one is no invoice.
#
# Now create, update, issue and a recurring run refuse a total ≤ 0 (400,
# pointing to "Gutschrift"); a negative discount line in an otherwise
# positive invoice stays allowed, and credit notes are unaffected.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-285-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier499-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
TODAY=$(date +%Y-%m-%d)
line() { echo "{\"description\":\"$1\",\"quantity\":$2,\"unit\":\"Std\",\"unitPrice\":$3,\"vatRate\":0.19}"; }
create() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[$1]}"; }

note "=== create ==="
create "$(line Minus 1 -500)"
assert_eq "−595 €: refused (was 201)" "$STATUS" "400"
assert_eq "…pointing to the credit note" "$(P "'Gutschrift' in d['message']")" "True"
create "$(line Menge -2 100)"
assert_eq "a negative quantity making it −238 €: refused" "$STATUS" "400"
create "$(line Null 0 100)"
assert_eq "0 €: refused (was 201)" "$STATUS" "400"
create "$(line Leistung 1 1000),$(line Rabatt 1 -100)"
assert_eq "a discount line in a positive invoice: fine" "$STATUS/$(P "d['total']")" "201/1071"
I=$(json_field "$BODY" id)

note "=== update ==="
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":[$(line Rabatt 1 -100)]}"
assert_eq "editing it down to −119 €: refused" "$STATUS" "400"
assert_eq "…it keeps its total" "$(q "select total::numeric(12,2) from \"Invoice\" where id='$I'")" "1071.00"

note "=== a draft saved negative before now is not issued ==="
create "$(line Leistung 1 100)"; J=$(json_field "$BODY" id)
q "update \"Invoice\" set total=-119, subtotal=-100, \"totalVat\"=-19 where id='$J'" >/dev/null
AS PUT "/api/v1/invoices/$J/status?companyId=$C" '{"status":"sent"}'
assert_eq "issuing it: refused" "$STATUS" "400"

note "=== credit notes are unaffected ==="
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"reason":"Teilgutschrift","amount":119}'
assert_eq "a credit note on the issued invoice" "$STATUS" "201"
assert_eq "…negative, as stored for credit notes" "$(P "float(d.get('total', 0)) < 0")" "True"

summary
