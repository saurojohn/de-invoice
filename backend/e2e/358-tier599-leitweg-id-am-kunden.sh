#!/bin/bash
# Tier 599 — a public-sector customer's Leitweg-ID can be entered
#
# XRechnung's BuyerReference (BT-10) is the Leitweg-ID when the invoice goes
# to a public authority. The generator has read it from the customer's
# address since Tier 115 — but the customer DTO refused the property
# ("address.property leitwegId should not exist") and no form had a field
# for it; the specs put it there by SQL. Through the product a B2G invoice
# went out with the customer's NAME as its buyer reference.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-358-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier599-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ADDR='"street":"Behördenstr. 1","postalCode":"53111","city":"Bonn","country":"DE"'
stored() { q "select coalesce(address->>'leitwegId','-') from \"Customer\" where id='$K'"; }
ref() { # invoice id → the XRechnung's BuyerReference
  curl -sS -o "$D/x.xml" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$1/xrechnung?companyId=$C"
  python3 -c "import re,sys;m=re.search(r'<cbc:BuyerReference>([^<]*)<',open(sys.argv[1],encoding='utf-8').read());print(m.group(1) if m else '-')" "$D/x.xml"
}

note "=== 1. a customer with a Leitweg-ID ==="
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Bundesamt","type":"business","contact":{"email":"amt@example.test"},"address":{'"$ADDR"',"leitwegId":"991-12345-67"}}'
K=$(json_field "$BODY" id)
assert_eq "created with it (was: 400 „property leitwegId should not exist“)" "$STATUS/$(stored)" "201/991-12345-67"
AS GET "/api/v1/customers/$K?companyId=$C"
assert_eq "…and it comes back with the customer" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['address'].get('leitwegId'))")" "991-12345-67"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Gutachten","quantity":1,"unit":"Stk","unitPrice":500,"vatRate":0.19}]}'
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "the XRechnung's BuyerReference is the Leitweg-ID (was: the customer's name)" "$(ref "$I")" "991-12345-67"

note "=== 2. changing and removing it ==="
AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{'"$ADDR"',"leitwegId":"04011000-1234512345-06"}}'
assert_eq "a Leitweg-ID with a Feinadresse" "$STATUS/$(stored)" "200/04011000-1234512345-06"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{'"$ADDR"'}}'
assert_eq "an address without it removes it" "$STATUS/$(stored)" "200/-"
assert_eq "…and the buyer reference falls back to the name" "$(ref "$I")" "$TAG Bundesamt"

note "=== 3. what is not a Leitweg-ID ==="
no() { AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{'"$ADDR"',"leitwegId":"'"$2"'"}}'; assert_eq "$1: 400" "$STATUS/$(stored)" "400/-"; }
no "free text" "Bundesamt Bonn"
no "no check digits" "991-12345"
no "one check digit" "991-12345-6"
no "markup" "991-<b>-67"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{'"$ADDR"',"leitwegId":""}}'
assert_eq "an empty field is accepted" "$STATUS" "200"
rm -rf "$D"
summary
