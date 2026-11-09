#!/bin/bash
# Tier 821 — inviting someone to register a company of their own
#
# The owner asked (09.11.2026) to let people they choose open their own
# company on the installation and write its invoices, with the registration
# closed to everyone else (Tier 820). The operator invites an address; the
# link registers one company, for that address, within seven days. The new
# company is apart: its admin is no operator, its invoices are its own.
#
# Closes the registration of this test database for a moment — reopened on
# exit, whatever happens.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login # the seed admin: the oldest company's, the operator
TAG="e2e-520-$(date +%s%N | cut -c1-13)"
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
register() { # email company [token]
  CALL POST /api/v1/auth/register "{\"email\":\"$1\",\"password\":\"Tier821-e2e\",\"companyName\":\"$2\"${3:+,\"companyInvite\":\"$3\"}}"
}

note "=== 1. only the operator invites ==="
CALL POST /api/v1/auth/register "{\"email\":\"$TAG-x@example.test\",\"password\":\"Tier821-e2e\",\"companyName\":\"$TAG X GmbH\"}"
X_U=$(py 'print(d["user"]["id"])'); X_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$TAG-b@example.test\"}" -H "x-user-id: $X_U" -H "x-company-id: $X_C"
assert_eq "the admin of another company may not invite a company" "$STATUS" "403"
CALL GET /api/v1/auth/registration/invites "" -H "x-user-id: $X_U" -H "x-company-id: $X_C"
assert_eq "…nor list the invitations" "$STATUS" "403"

CALL PUT /api/v1/auth/registration '{"open":false}' "${OP[@]}"
assert_eq "fixture: the registration closed" "$(py 'print(d["open"])')" "False"

CALL POST /api/v1/auth/registration/invites '{"email":"kein-email"}' "${OP[@]}"
assert_eq "an address that is none: 400" "$STATUS" "400"
B="$TAG-b@example.test"
B_UPPER=$(echo "$B" | tr '[:lower:]' '[:upper:]')
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$B_UPPER\"}" "${OP[@]}"
assert_eq "the operator invites an address (stored lower-case), the link comes back" \
  "$STATUS $(py 'print(d["email"], "/register?company-invite=" in d["link"], type(d["mailed"]).__name__)')" "201 $B True bool"
TOKEN=$(py 'print(d["link"].split("company-invite=")[1])')
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$B\"}" "${OP[@]}"
assert_eq "a second open invitation for the same address: 400" "$STATUS" "400"

note "=== 2. the link ==="
CALL GET "/api/v1/auth/registration?invite=$TOKEN"
assert_eq "the page learns the address the link is for, the registration stays closed" "$(py 'print(d["open"], d["invite"]["email"])')" "False $B"
CALL GET "/api/v1/auth/registration?invite=not-a-token-not-a-token-x"
assert_eq "an unknown token names nobody" "$(py 'print(d["invite"])')" "None"
register "$TAG-z@example.test" "$TAG Z GmbH" "$TOKEN"
assert_eq "the link with another address: refused, and no company" \
  "$STATUS $(py 'print("andere E-Mail" in d["message"])') $(q "select count(*) from \"Company\" where name='$TAG Z GmbH'")" "403 True 0"
register "$B" "$TAG B GmbH"
assert_eq "the address without the link: refused (closed)" "$STATUS" "403"
register "$B" "$TAG B GmbH" "$TOKEN"
assert_eq "the address with the link: its company is made" "$STATUS" "201"
B_U=$(py 'print(d["user"]["id"])'); B_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')

note "=== 3. a company of its own ==="
assert_eq "a new company, not the operator's" "$( [[ -n "$B_C" && "$B_C" != "$COMPANY_ID" ]] && echo yes)" "yes"
CALL GET /api/v1/auth/me "" -H "x-user-id: $B_U" -H "x-company-id: $B_C"
assert_eq "its admin, and no operator" "$(py 'print(d["role"], d["operator"])')" "admin False"
fixture_issuer "$B_C"
CALL POST "/api/v1/customers?companyId=$B_C" '{"name":"Kunde von B","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}' -H "x-user-id: $B_U" -H "x-company-id: $B_C"
K=$(json_field "$BODY" id)
CALL POST "/api/v1/invoices?companyId=$B_C" "{\"customerId\":\"$K\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.19}]}" -H "x-user-id: $B_U" -H "x-company-id: $B_C"
assert_eq "it writes its own invoice" "$STATUS $(py 'print(d["total"])')" "201 595"
CALL GET "/api/v1/invoices?companyId=$COMPANY_ID" "" -H "x-user-id: $B_U" -H "x-company-id: $COMPANY_ID"
assert_eq "…and cannot read the operator's (not its company: refused)" "$( [[ "$STATUS" == 401 || "$STATUS" == 403 ]] && echo refused || echo "$STATUS")" "refused"

note "=== 4. once only; revoked is revoked ==="
register "$TAG-b2@example.test" "$TAG B2 GmbH" "$TOKEN"
assert_eq "the link a second time: refused" "$STATUS" "403"
CALL GET /api/v1/auth/registration/invites "" "${OP[@]}"
assert_eq "the list: used, by that company, without the token's hash" \
  "$(py "i=[x for x in d if x['email']=='$B'][0];print(i['status'], i['companyId']=='$B_C', 'tokenHash' in i)")" "used True False"
C="$TAG-c@example.test"
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$C\"}" "${OP[@]}"
C_TOKEN=$(py 'print(d["link"].split("company-invite=")[1])'); C_ID=$(py 'print(d["id"])')
CALL DELETE "/api/v1/auth/registration/invites/$C_ID" "" "${OP[@]}"
assert_eq "the operator revokes an open invitation" "$STATUS $(py 'print(d["status"])')" "200 revoked"
register "$C" "$TAG C GmbH" "$C_TOKEN"
assert_eq "…and its link no longer registers" "$STATUS" "403"
CALL DELETE "/api/v1/auth/registration/invites/$C_ID" "" "${OP[@]}"
assert_eq "revoking it again: 400" "$STATUS" "400"
assert_eq "created and revoked are in the audit log" \
  "$(q "select count(*) filter (where action='company_invite_created') >= 2, count(*) filter (where action='company_invite_revoked') >= 1 from \"AuditLog\" where \"companyId\"='$COMPANY_ID' and \"createdAt\" > now() - interval '5 minutes'")" "t|t"
summary
