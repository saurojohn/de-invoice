#!/bin/bash
# Tier 631 — the customer portal: one customer against another, and what a
# customer may write into its own record
#
# The check §9 item 24 named as not done. A company with customers X and Y,
# a second company with Z, an issued invoice and a portal session for each.
# Isolation holds: X's session lists X's invoices and answers 404 for the
# page, the PDF and "I have paid" of Y's and of Z's invoice.
# What it found is in PATCH /customer-portal/profile:
#   * X set its e-mail to Y's — 200. The address is the login: the session
#     link Y asks for next goes out for "the customer with this address".
#     The company's own form had the same hole on update (create refuses a
#     duplicate with 409, update did not).
#   * a USt-IdNr. was stored as typed („DE000“); the company's form checks
#     and normalises it (Tier 490).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-375-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier631-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { # method path token [body]   — the portal: no login, the session token
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API/api/v1/customer-portal/$2?token=$3" -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
mail() { echo "$TAG-$1@example.test" | tr 'A-Z' 'a-z'; }
make() { # name → sets K (customer), I (issued invoice), T (session token)
  AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' '$1'","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$(mail $1)'"}}'; K=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'; I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/customer-portal/admin/create-session" '{"customerId":"'$K'"}'; T=$(echo "$BODY" | grep -oE '[0-9a-f]{64}' | head -1)
}
stored() { q "select $2 from \"Customer\" where id='$1'"; }

company b; make Zoe; KZ=$K; IZ=$I
company a; make Xaver; KX=$K; IX=$I; TX=$T
make Yvonne; KY=$K; IY=$I; TY=$T
[[ -n "$TX" && -n "$TY" && -n "$IZ" ]] && pass "fixture: X and Y in one company, Z in another — each with an issued invoice and a portal session" || { fail "fixture: $BODY"; summary; exit 1; }

note "=== 1. one customer against another ==="
P GET invoices "$TX"
assert_eq "X's session lists X's invoice only" "$STATUS $(field "[i['id'] for i in d['invoices']] == ['$IX']")" "200 True"
for inv in "$IY" "$IZ"; do
  P GET "invoice/$inv" "$TX"; R="${R:-}$STATUS/"
  R+="$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoice/$inv/pdf?token=$TX")/"
  P POST "invoice/$inv/mark-paid" "$TX" '{}'; R+="$STATUS "
done
assert_eq "Y's invoice (same company) and Z's (another company): page, PDF and 'I have paid' are 404 for X" "$R" "404/404/404 404/404/404 "
P GET "invoice/$IX" "$TX"
assert_eq "X's own invoice is there" "$STATUS" "200"
P GET invoices "0000000000000000000000000000000000000000000000000000000000000000"
assert_eq "a token that is none: 401" "$STATUS" "401"
P PATCH profile "$TX" '{"customerId":"'$KY'"}'; A=$STATUS
P PATCH profile "$TX" '{"creditLimit":999999}'; B=$STATUS
P PATCH profile "$TX" '{"paymentTerms":365}'
assert_eq "the profile takes no other customer's id, no credit limit, no payment terms" "$A $B $STATUS" "400 400 400"

note "=== 2. the address is the login ==="
P PATCH profile "$TX" '{"contact":{"email":"'$(mail Yvonne)'"}}'
assert_eq "X cannot take Y's e-mail address (was: 200)" "$STATUS/$(stored "$KX" "contact->>'email'")/$(q "select count(*) from \"Customer\" where \"companyId\"='$C' and lower(contact->>'email')='$(mail Yvonne)'")" "400/$(mail Xaver)/1"
P PATCH profile "$TX" '{"contact":{"email":"'$(mail Yvonne | tr 'a-z' 'A-Z')'"}}'
assert_eq "…nor in capitals" "$STATUS" "400"
assert_eq "…and the answer does not say whose it is" "$(echo "$BODY" | grep -c 'kann nicht verwendet werden')/$(echo "$BODY" | grep -ci 'yvonne')" "1/0"
P PATCH profile "$TX" '{"contact":{"email":"'$(mail Xaver-neu)'","phone":"030 123"}}'
assert_eq "an address of its own is taken" "$STATUS $(stored "$KX" "contact->>'email'")" "200 $(mail Xaver-neu)"
P PATCH profile "$TX" '{"contact":{"email":"'$(mail Zoe)'"}}'
assert_eq "an address used in another company is no one's business here" "$STATUS" "200"
AS PUT "/api/v1/customers/$KY?companyId=$C" '{"contact":{"email":"'$(mail Zoe)'"}}'
assert_eq "the company's own form: Y cannot be given X's address either (was: 200)" "$STATUS $(stored "$KY" "contact->>'email'")" "409 $(mail Yvonne)"
AS PUT "/api/v1/customers/$KY?companyId=$C" '{"name":"'$TAG' Yvonne GmbH","contact":{"email":"'$(mail Yvonne)'"}}'
assert_eq "…saving Y with its own address works as before" "$STATUS" "200"
q "update \"Customer\" set contact = jsonb_set(contact, '{email}', '\"$(mail Zoe)\"') where id='$KY'" >/dev/null
AS PUT "/api/v1/customers/$KY?companyId=$C" '{"name":"'$TAG' Yvonne AG","contact":{"email":"'$(mail Zoe)'"}}'
assert_eq "a customer that shares an address from before can still be edited" "$STATUS $(stored "$KY" name | grep -c 'AG$')" "200 1"

note "=== 3. the USt-IdNr. ==="
P PATCH profile "$TX" '{"vatId":"DE000"}'
assert_eq "a number that is none is refused, as in the company's form (was: stored)" "$STATUS/$(echo "$BODY" | grep -c 'Format einer DE-Nummer')/$(stored "$KX" 'coalesce("vatId", $$-$$)')" "400/1/-"
P PATCH profile "$TX" '{"vatId":"de 136 695 976"}'
assert_eq "a valid one is stored normalised" "$STATUS $(stored "$KX" '"vatId"')" "200 DE136695976"
P PATCH profile "$TX" '{"vatId":null}'
assert_eq "…and can be taken away" "$STATUS $(stored "$KX" '"vatId" is null')" "200 t"
P PATCH profile "$TX" '{"name":"'$TAG' Xaver & Söhne","address":{"street":"Neue Str. 5"}}'
assert_eq "name and address are the customer's to correct" "$STATUS $(stored "$KX" "name || '|' || (address->>'street') || '|' || (address->>'city')")" "200 $TAG Xaver & Söhne|Neue Str. 5|München"
summary
