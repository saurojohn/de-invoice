#!/bin/bash
# Tier 823 — the companies on the installation, for its operator
#
# The owner asked (10.11.2026) for a list of the companies on the server on
# „Systembetrieb": since the registration can be closed and companies invited
# (Tiers 820 / 821), nothing showed what came of it. GET /admin/companies —
# the operator only — lists each company with its admins, members, number of
# invoices, last sign-in and how it came (the operator's own, an invitation,
# the registration).
#
# Measured on the way: the password sign-in never wrote `User.lastLogin` —
# only the 2FA route did — so the user page said „Nie" for every account
# without 2FA. A sign-in (and the registration, which signs in) records it.
#
# Closes the registration of this test database for a moment — reopened on
# exit, whatever happens.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login # the seed admin: the oldest company's, the operator
TAG="e2e-521-$(date +%s%N | cut -c1-13)"
OP=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
reopen() { curl -sS -o /dev/null -X PUT "${OP[@]}" -H "Content-Type: application/json" "$API/api/v1/auth/registration" -d '{"open":true}'; }
trap reopen EXIT

CALL() { # method path [body] [headers…]
  local m=$1 p=$2 b=${3:-}; shift 3 2>/dev/null || shift $#
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$m" "$API$p" -H "Content-Type: application/json" "$@" ${b:+-d "$b"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
A="$TAG-a@example.test"
B="$TAG-b@example.test"

note "=== 1. the fixtures: a registered company with an invoice, an invited one ==="
CALL POST /api/v1/auth/register "{\"email\":\"$A\",\"password\":\"Tier823-e2e\",\"companyName\":\"$TAG A GmbH\"}"
A_U=$(py 'print(d["user"]["id"])'); A_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
[[ -n "$A_C" ]] && pass "fixture: company A registered" || { fail "register A → $STATUS"; summary; exit 1; }
AS_A=(-H "x-user-id: $A_U" -H "x-company-id: $A_C")
fixture_issuer "$A_C"
CALL POST "/api/v1/customers?companyId=$A_C" '{"name":"Kunde von A","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}' "${AS_A[@]}"
K=$(json_field "$BODY" id)
CALL POST "/api/v1/invoices?companyId=$A_C" "{\"customerId\":\"$K\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}" "${AS_A[@]}"
assert_eq "fixture: an invoice of A" "$STATUS" "201"

CALL PUT /api/v1/auth/registration '{"open":false}' "${OP[@]}"
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$B\"}" "${OP[@]}"
TOKEN=$(py 'print(d["link"].split("company-invite=")[1])')
CALL POST /api/v1/auth/register "{\"email\":\"$B\",\"password\":\"Tier823-e2e\",\"companyName\":\"$TAG B GmbH\",\"companyInvite\":\"$TOKEN\"}"
B_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
assert_eq "fixture: company B registered through an invitation" "$STATUS" "201"
reopen

note "=== 2. the operator's only ==="
CALL GET /api/v1/admin/companies "" "${AS_A[@]}"
assert_eq "another company's admin: 403" "$STATUS" "403"
CALL GET /api/v1/admin/companies ""
assert_eq "signed out: refused" "$( [[ "$STATUS" == 401 || "$STATUS" == 403 ]] && echo refused || echo "$STATUS")" "refused"

note "=== 3. the list ==="
CALL GET "/api/v1/admin/companies?q=$TAG" "" "${OP[@]}"
assert_eq "searching the tag finds the two, newest first" \
  "$STATUS $(py 'print(d["total"], [c["name"] for c in d["companies"]])')" "200 2 ['$TAG B GmbH', '$TAG A GmbH']"
assert_eq "B came by invitation, to its address" \
  "$(py 'c=d["companies"][0];print(c["origin"], c["invitedEmail"], c["admins"], c["members"], c["invoices"])')" "invite $B ['$B'] 1 0"
assert_eq "A by the registration, with its invoice" \
  "$(py 'c=d["companies"][1];print(c["origin"], c["invitedEmail"], c["admins"], c["members"], c["invoices"], c["closedAt"])')" "registration None ['$A'] 1 1 None"
assert_eq "a row says nothing of the books but the count of invoices" \
  "$(py 'print(sorted(d["companies"][0].keys()))')" \
  "['admins', 'closedAt', 'createdAt', 'id', 'invitedEmail', 'invoices', 'lastLogin', 'members', 'name', 'origin']"
CALL GET "/api/v1/admin/companies?q=$(echo "$TAG-A@EXAMPLE.TEST" | sed 's/@/%40/')" "" "${OP[@]}"
assert_eq "…and an admin's address finds its company, in any case" "$(py 'print(d["total"], d["companies"][0]["name"])')" "1 $TAG A GmbH"
OPNAME=$(q "select name from \"Company\" where id='$COMPANY_ID'")
CALL GET "/api/v1/admin/companies?q=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$OPNAME")" "" "${OP[@]}"
assert_eq "the operator's own company is marked so" \
  "$(py "print([c['origin'] for c in d['companies'] if c['id']=='$COMPANY_ID'])")" "['operator']"
CALL GET "/api/v1/admin/companies?take=1" "" "${OP[@]}"
assert_eq "the totals are the installation's" \
  "$(py 'print(d["totals"]["companies"], d["totals"]["open"], d["totals"]["users"], d["total"]==d["totals"]["companies"])')" \
  "$(q 'select count(*) from "Company"') $(q 'select count(*) from "Company" where "closedAt" is null') $(q 'select count(*) from "User"') True"

note "=== 4. pages ==="
CALL GET "/api/v1/admin/companies?q=$TAG&take=1" "" "${OP[@]}"
P1=$(py 'print(d["companies"][0]["name"], len(d["companies"]), d["total"])')
CALL GET "/api/v1/admin/companies?q=$TAG&take=1&skip=1" "" "${OP[@]}"
assert_eq "one at a time: B, then A" "$P1 / $(py 'print(d["companies"][0]["name"], len(d["companies"]))')" "$TAG B GmbH 1 2 / $TAG A GmbH 1"
for bad in "take=0" "take=201" "skip=-1" "take=abc"; do
  CALL GET "/api/v1/admin/companies?$bad" "" "${OP[@]}"
  assert_eq "$bad: 400" "$STATUS" "400"
done

note "=== 5. the last sign-in ==="
assert_eq "the registration signed in, and is recorded" \
  "$(q "select \"lastLogin\" is not null from \"User\" where id='$A_U'")" "t"
q "update \"User\" set \"lastLogin\"=null where id='$A_U'" >/dev/null
CALL POST /api/v1/auth/login "{\"email\":\"$A\",\"password\":\"Tier823-e2e\"}"
assert_eq "a password sign-in records it (was only the 2FA route)" \
  "$STATUS $(q "select \"lastLogin\" > now() - interval '1 minute' from \"User\" where id='$A_U'")" "200 t"
CALL GET "/api/v1/admin/companies?q=$TAG-a" "" "${OP[@]}"
assert_eq "…and the list shows it" "$(py 'print(d["companies"][0]["lastLogin"] is not None)')" "True"
summary
