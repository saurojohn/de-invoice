#!/bin/bash
# Tier 490 — the USt-IdNr. is normalised and its EU format checked
#
# Measured before: a customer's USt-IdNr. was stored as typed — "fr 12 345 678
# 901" with spaces and lower case, "FR1" and the Greek "GR123456789" (Greece's
# prefix is EL) accepted — and Tier 486's igL check, which reads the prefix
# only, issued tax-free igL invoices to "FR1" and "GR…". Now customers,
# suppliers and the company store the number normalised; a malformed number
# of an EU state is refused (the CSV import reports the row); numbers of
# non-EU states (Swiss CHE…) are left alone; the igL check tests the format
# too (a number stored before the check).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-276-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier490-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
customer() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"vatId\":\"$1\",\"address\":{\"country\":\"FR\"}}"; }

customer "FR1";               assert_eq "FR1 refused (was stored)" "$STATUS" "400"
customer "GR123456789";       assert_eq "GR… refused (was stored)" "$STATUS" "400"
assert_eq "…pointing to EL" "$(P "'EL' in d['message']")" "True"
customer "fr 12 345 678 901"; assert_eq "a valid number typed loosely is taken" "$STATUS" "201"
assert_eq "…and stored normalised (was as typed)" "$(P "d['vatId']")" "FR12345678901"
customer "EL123456789";       assert_eq "a Greek number with EL is taken" "$STATUS" "201"
customer "CHE-123.456.789";   assert_eq "a Swiss UID is left alone" "$STATUS/$(P "d['vatId']")" "201/CHE123456789"
FR=$(customer "FR12345678901"; json_field "$BODY" id)

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"L","vatId":"DE12","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'
assert_eq "a supplier's DE12 refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C" '{"vatId":"de 123 456 789"}'
assert_eq "the company's own number normalised" "$STATUS/$(P "d['vatId']")" "200/DE123456789"

note "=== a number stored before this tier ==="
docker exec "${PG_CONTAINER:-de-invoice-postgres}" psql -U de_invoice -d de_invoice -tAc \
  "update \"Customer\" set \"vatId\"='FR1' where id='$FR'" >/dev/null
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$FR\",\"issueDate\":\"2026-09-01\",\"euTransaction\":true,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
assert_eq "no igL to it (was 201)" "$STATUS" "400"

AS POST "/api/v1/customers/import?companyId=$C" '{"rows":[{"name":"'$TAG' CSV ok","vatId":"NL 123456789 B01"},{"name":"'$TAG' CSV bad","vatId":"NL123"}]}'
assert_eq "CSV: the valid row imported, the malformed one reported" "$(P "(d['imported'], len(d['errors']))")" "(1, 1)"

summary
