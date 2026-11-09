#!/bin/bash
# Tier 820 — after the first company, new people by invitation only
#
# Registration was open to anyone with the address: each registration made a
# new company on the owner's server. The owner asked (09.11.2026) that once
# the first company exists, people come in by invitation. The operator (the
# first company's admin) opens or closes it: PUT /auth/registration; the
# production compose file closes it by default (REGISTRATION=first-only), the
# test suites run with it open. GET /auth/registration says which, publicly.
#
# Closes the registration of this test database for a moment — reopened on
# exit, whatever happens.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login # the seed admin: the oldest company's, the operator
TAG="e2e-519-$(date +%s%N | cut -c1-13)"
LOG=/tmp/backend.log
OP=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json")
reopen() { curl -sS -o /dev/null -X PUT "${OP[@]}" "$API/api/v1/auth/registration" -d '{"open":true}'; }
trap reopen EXIT

CALL() { # method path [body] [headers…]
  local m=$1 p=$2 b=${3:-}; shift 3 2>/dev/null || shift $#
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$m" "$API$p" -H "Content-Type: application/json" "$@" ${b:+-d "$b"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
register() { CALL POST /api/v1/auth/register "{\"email\":\"$1@example.test\",\"password\":\"Tier820-e2e\",\"companyName\":\"$1 GmbH\"}"; }

note "=== 1. the state, publicly ==="
CALL GET /api/v1/auth/registration
assert_eq "GET /auth/registration without a session: open (the test suites run with it open)" "$STATUS $(py 'print(d["open"])')" "200 True"

note "=== 2. only the operator decides ==="
register "$TAG-a"
A_U=$(py 'print(d["user"]["id"])'); A_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
assert_eq "fixture: a company registered while it is open" "$STATUS" "201"
CALL PUT /api/v1/auth/registration '{"open":false}' -H "x-user-id: $A_U" -H "x-company-id: $A_C"
assert_eq "the admin of another company may not close it" "$STATUS" "403"
CALL PUT /api/v1/auth/registration '{"open":"no"}' "${OP[@]}"
assert_eq "open must be true or false" "$STATUS" "400"

note "=== 3. closed: no registration, the invitation still works ==="
CALL PUT /api/v1/auth/registration '{"open":false}' "${OP[@]}"
assert_eq "the operator closes it" "$STATUS $(py 'print(d["open"], d["source"])')" "200 False setting"
CALL GET /api/v1/auth/registration
assert_eq "…and the page is told" "$(py 'print(d["open"])')" "False"
register "$TAG-b"
assert_eq "a registration is refused, saying how one comes in" "$STATUS $(py 'print("Administrator ein" in d["message"])')" "403 True"
assert_eq "…and no company was made" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"Company\" where name='$TAG-b GmbH'")" "0"
CALL POST "/api/v1/users/invitations?companyId=$A_C" "{\"email\":\"$TAG-c@example.test\",\"role\":\"accountant\"}" -H "x-user-id: $A_U" -H "x-company-id: $A_C"
assert_eq "an admin still invites" "$STATUS" "201"
ITOKEN=$(grep -o "register?invite=[A-Za-z0-9_-]*" "$LOG" | tail -1 | cut -d= -f2)
CALL POST /api/v1/invitations/accept "{\"token\":\"$ITOKEN\",\"password\":\"Tier820-e2e\"}"
assert_eq "…and the invited person comes in, into that company" \
  "$STATUS $(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"UserCompany\" r join \"User\" u on u.id=r.\"userId\" where u.email='$TAG-c@example.test' and r.\"companyId\"='$A_C'" 2>/dev/null || echo '?')" \
  "201 1"

note "=== 4. opened again ==="
CALL PUT /api/v1/auth/registration '{"open":true}' "${OP[@]}"
assert_eq "the operator opens it" "$STATUS $(py 'print(d["open"])')" "200 True"
register "$TAG-d"
assert_eq "…and a registration goes through" "$STATUS" "201"
assert_eq "both changes are in the audit log" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(distinct action, ',' order by action) from \"AuditLog\" where \"companyId\"='$COMPANY_ID' and action like 'registration_%' and \"createdAt\" > now() - interval '5 minutes'")" \
  "registration_closed,registration_opened"
summary
