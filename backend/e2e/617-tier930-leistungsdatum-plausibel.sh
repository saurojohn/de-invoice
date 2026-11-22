#!/bin/bash
# Tier 930 — a Leistungsdatum within reason
#
# Since Tier 912 the Leistungsdatum decides the VAT period. Measured: an
# invoice of today with the Leistungsdatum 1990-01-01, another with
# 2099-12-31 — created and issued without a word; the tax went into a period
# nobody files, or decades ahead. Now: at most ten years before the invoice
# date (§§ 147, 169 AO), at most three after it; the form warns from a year on.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-617-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier930-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 617","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
create() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",$1,\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"; }

create '"deliveryDate":"1990-01-01"'
assert_eq "Leistungsdatum 1990-01-01: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying what to check" "$(echo "$BODY" | grep -c "mehr als zehn Jahre vor dem Rechnungsdatum")" "1"
create '"deliveryDate":"2099-12-31"'
assert_eq "Leistungsdatum 2099-12-31: 400 (was 201)" "$STATUS" "400"
create "\"servicePeriodStart\":\"1990-01-01\",\"servicePeriodEnd\":\"1990-12-31\""
assert_eq "a Leistungszeitraum of 1990: 400" "$STATUS" "400"
create "\"deliveryDate\":\"$((Y - 2))-06-15\""
assert_eq "two years back — a late invoice: 201" "$STATUS" "201"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"deliveryDate":"1990-01-01"}'
assert_eq "changed to 1990 in the draft: 400" "$STATUS" "400"
create "\"deliveryDate\":\"$((Y + 1))-01-05\""
assert_eq "an advance invoice for next January: 201" "$STATUS" "201"

summary
