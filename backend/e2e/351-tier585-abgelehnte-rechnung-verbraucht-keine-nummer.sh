#!/bin/bash
# Tier 585 — a refused create does not use up a document number
#
# create() took the number first and checked the request afterwards. A
# sequence does not roll back, so every refused create — no customer, an
# unknown customer, § 13b together with § 1a — left a hole in the series:
# 000001, a refused create, 000003 (found while reconciling a month by hand:
# INV-2026-000003 did not exist). The number is now the last thing taken
# before the insert, and it goes back if the insert fails.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-351-$(date +%s%N | cut -c1-13)"
Y=$(date +%Y); TODAY=$(date +%Y-%m-%d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier585-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
ITEM='[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
mk() { # customer-json extra → STATUS, N (not to be called in a subshell)
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":'"$1"',"issueDate":"'$TODAY'","items":'"$ITEM$2"'}'
  N=$(json_field "$BODY" invoiceNumber); I=$(json_field "$BODY" id)
}
numbers() { q "select coalesce(string_agg(\"sequenceNumber\"::text, ',' order by \"sequenceNumber\"), '-') from \"Invoice\" where \"companyId\"='$C' and type='INV'"; }

note "=== 1. the series starts ==="
mk "\"$K\"" ""; FIRST=$I
assert_eq "the first invoice" "$STATUS/$N" "201/INV-$Y-000001"

note "=== 2. three refused creates ==="
mk null ""
assert_eq "no customer: 400" "$STATUS" "400"
mk '"00000000-0000-0000-0000-000000000000"' ""
assert_eq "an unknown customer: 404" "$STATUS" "404"
mk "\"$K\"" ',"reverseCharge":true,"euTransaction":true'
assert_eq "§ 13b together with § 1a: 400" "$STATUS" "400"
mk "\"$K\"" ""
assert_eq "…and the next invoice is 000002 (was 000005)" "$STATUS/$N" "201/INV-$Y-000002"
assert_eq "the series has no hole" "$(numbers)" "1,2"

note "=== 3. concurrent creates still get one number each ==="
D=$(mktemp -d)
for i in 1 2 3 4 5 6; do
  curl -sS -o "$D/$i.json" -X POST "$API/api/v1/invoices?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"customerId":"'$K'","issueDate":"'$TODAY'","items":'"$ITEM"'}' &
done
wait
assert_eq "six at once: 3 to 8, each once" "$(numbers)" "1,2,3,4,5,6,7,8"
# a refused create among good ones must not move the sequence under a number in use
for i in 1 2 3; do
  curl -sS -o /dev/null -X POST "$API/api/v1/invoices?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"customerId":null,"issueDate":"'$TODAY'","items":'"$ITEM"'}' &
  curl -sS -o /dev/null -X POST "$API/api/v1/invoices?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"customerId":"'$K'","issueDate":"'$TODAY'","items":'"$ITEM"'}' &
done
wait
assert_eq "three good and three refused at once: 9 to 11, nothing twice, nothing missing" "$(numbers)" "1,2,3,4,5,6,7,8,9,10,11"
assert_eq "…no number was given out twice" "$(q "select count(*) - count(distinct \"invoiceNumber\") from \"Invoice\" where \"companyId\"='$C'")" "0"

note "=== 4. credit notes keep their own series ==="
AS PUT "/api/v1/invoices/$FIRST/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$FIRST/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "a credit note" "$STATUS/$(json_field "$BODY" invoiceNumber)" "201/CN-$Y-000001"
AS POST "/api/v1/invoices/00000000-0000-0000-0000-000000000000/credit-note?companyId=$C" '{"reason":"x"}'
assert_eq "a credit note for an unknown invoice: 404" "$STATUS" "404"
mk "\"$K\"" ""; SECOND=$I
AS PUT "/api/v1/invoices/$SECOND/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$SECOND/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "…the next credit note is 000002" "$STATUS/$(json_field "$BODY" invoiceNumber)" "201/CN-$Y-000002"
rm -rf "$D"
summary
