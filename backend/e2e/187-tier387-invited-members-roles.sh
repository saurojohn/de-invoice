#!/bin/bash
# Tier 387 — an accepted invitation grants access, and a role change changes
# the permissions
#
# HeaderAuthGuard grants access through UserCompany (Tier 66); only
# registration created that row, and PATCH /users/:id/role changed User.role
# only. Measured before the change:
#   invited viewer: POST /invitations/accept → 201, /auth/login → 200, then
#                   every request 401 "Kein Zugriff auf diese Firma"
#   member with UserCompany role accountant, PATCH role → viewer → 200, listed
#                   as viewer, POST /customers still 201
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-187-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

REG=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-admin@example.test\",\"password\":\"Tier387-e2e\",\"companyName\":\"$TAG\"}")
read -r UA CA < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${CA:-}" ]] && pass "fresh company with its admin" || { fail "register failed"; summary; exit 1; }
req() { # user method path [body]
  local resp
  if [[ -n "${4:-}" ]]; then
    resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $CA" -H "Content-Type: application/json" -d "$4")
  else
    resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $CA")
  fi
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
Q="companyId=$CA"

note "=== 1. an invited user can work in the company ==="
EMAIL="$TAG-member@example.test"
req "$UA" POST "/api/v1/users/invitations?$Q" "{\"email\":\"$EMAIL\",\"role\":\"viewer\"}"
assert_status 201 "admin invites a viewer (settings/users page)"
INV=$(json_field "$BODY" id)
req "$UA" POST "/api/v1/users/invitations/$INV/resend?$Q" '{}'
TOKEN=$(json_field "$BODY" tokenPlain)
ACCEPT=$(curl -s -w "\n%{http_code}" -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"Tier387member1\"}")
assert_eq "invitation accepted" "$(echo "$ACCEPT" | tail -n1)" "201"
MEMBER=$(json_field "$(echo "$ACCEPT" | sed '$d')" userId)
assert_eq "…membership row with the invited role" "$(sql "SELECT role FROM \"UserCompany\" WHERE \"userId\" = '$MEMBER' AND \"companyId\" = '$CA';")" "viewer"
LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Tier387member1\"}")
assert_eq "member logs in" "$LOGIN" "200"
req "$MEMBER" GET "/api/v1/customers?$Q"
assert_status 200 "member reads customers (was 401 Kein Zugriff auf diese Firma)"
req "$MEMBER" POST "/api/v1/customers?$Q" "{\"name\":\"$TAG viewer\",\"type\":\"business\"}"
assert_status 403 "…but as viewer cannot create one"

note "=== 2. a role change changes the permissions ==="
req "$UA" PATCH "/api/v1/users/$MEMBER/role?$Q" '{"role":"accountant"}'
assert_status 200 "promote to accountant"
assert_eq "…response role" "$(json_field "$BODY" role)" "accountant"
req "$MEMBER" POST "/api/v1/customers?$Q" "{\"name\":\"$TAG accountant\",\"type\":\"business\"}"
assert_status 201 "…member creates a customer"
req "$UA" PATCH "/api/v1/users/$MEMBER/role?$Q" '{"role":"viewer"}'
assert_status 200 "demote to viewer"
assert_eq "…membership role" "$(sql "SELECT role FROM \"UserCompany\" WHERE \"userId\" = '$MEMBER' AND \"companyId\" = '$CA';")" "viewer"
req "$MEMBER" POST "/api/v1/customers?$Q" "{\"name\":\"$TAG demoted\",\"type\":\"business\"}"
assert_status 403 "…member can no longer create customers (was 201)"
req "$UA" GET "/api/v1/users?$Q"
LISTED=$(echo "$BODY" | python3 -c "import sys,json;print(next((u['role'] for u in json.load(sys.stdin)['users'] if u['id']=='$MEMBER'),''))" 2>/dev/null)
assert_eq "…user list shows viewer" "$LISTED" "viewer"

note "=== 3. the company keeps an admin ==="
req "$UA" PATCH "/api/v1/users/$UA/role?$Q" '{"role":"viewer"}'
assert_status 400 "the only admin cannot demote themselves"
assert_eq "…still admin" "$(sql "SELECT role FROM \"UserCompany\" WHERE \"userId\" = '$UA' AND \"companyId\" = '$CA';")" "admin"
req "$UA" PATCH "/api/v1/users/00000000-0000-0000-0000-000000000000/role?$Q" '{"role":"viewer"}'
assert_status 404 "unknown user"

note "=== 4. a member invited before Tier 387 (no membership row) ==="
# the state every accepted invitation was left in: a User in this company, no UserCompany
OLD=$(sql "INSERT INTO \"User\" (id, \"companyId\", email, \"passwordHash\", role, status) VALUES (gen_random_uuid()::text, '$CA', '$TAG-old@example.test', 'x', 'viewer', 'active') RETURNING id;" | head -1)
req "$OLD" GET "/api/v1/customers?$Q"
assert_status 401 "no access without a membership row"
req "$UA" PATCH "/api/v1/users/$OLD/role?$Q" '{"role":"accountant"}'
assert_status 200 "admin sets the role"
assert_eq "…membership row created" "$(sql "SELECT role FROM \"UserCompany\" WHERE \"userId\" = '$OLD' AND \"companyId\" = '$CA';")" "accountant"
req "$OLD" GET "/api/v1/customers?$Q"
assert_status 200 "…and the member has access"
REG_B=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-other@example.test\",\"password\":\"Tier387-e2e\",\"companyName\":\"$TAG other\"}")
UB=$(json_field "$REG_B" user.id)
req "$UA" PATCH "/api/v1/users/$UB/role?$Q" '{"role":"viewer"}'
assert_status 404 "another company's user cannot be given a role here"
assert_eq "…no membership in this company" "$(sql "SELECT count(*) FROM \"UserCompany\" WHERE \"userId\" = '$UB' AND \"companyId\" = '$CA';")" "0"

summary
exit $?
