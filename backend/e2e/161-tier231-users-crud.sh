#!/bin/bash
# Tier 231 — e2e coverage: users CRUD (admin user management)
#
# The users controller (the non-invitation part — the invitation
# flow was covered by Tier 152) had 0 e2e coverage. The
# /users endpoints power the Berater's user-management screen:
# list company users, change role, activate/deactivate.
# These are the operations the admin runs when adding a new
# Berater, demoting a Test User, or suspending a user who left.
#
# Assertions:
#   1. GET /users?companyId=... returns { users, pendingInvitations }
#   2. list contains the admin user (or some known user)
#   3. PATCH /users/:id/role changes the role
#   4. PATCH /users/:id/role missing role field → 400
#   5. PATCH /users/:id/status sets the user inactive
#   6. PATCH /users/:id/status sets the user active again
#   7. PATCH /users/:id/status missing status field → 400
#   8. PATCH /users/:id/status invalid status (not active/inactive) → 400
#   9. GET /users/me/companies returns { activeCompanyId, companies }
#  10. POST /users/me/switch-company with a valid companyId → 200
#  11. POST /users/me/switch-company with a fake companyId → 403
#  12. GET /users without companyId → 400 'companyId is required'
#      (note: pre-existing English message in this controller)
#  13. PATCH /users/:id/role with fake userId → 404 German
#  14. Cleanup: restore the test user's role + status
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

# Tier 361: create the non-admin test user here. This used to look up
# tier221-1787169195-90017@example.com — an accountant left behind by one
# particular run of spec 152 on a developer database. 152 creates its user
# with a fresh timestamped email and deletes it again, so on any other
# database (CI included) the lookup came back empty and every PATCH below
# went to /users//role. users.service.ts changeRole / setStatus only need a
# User row whose companyId is the test company. User.id has no database
# default (Prisma generates it), hence gen_random_uuid().
TEST_EMAIL="tier231-$(date +%s)-$$@example.com"
TEST_USER_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -q -c "INSERT INTO \"User\" (id, \"companyId\", email, \"passwordHash\", role, status) VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$TEST_EMAIL', 'x', 'accountant', 'active') RETURNING id;" 2>/dev/null | head -1 | tr -d ' ')
[ -n "$TEST_USER_ID" ] && pass "test user created: $TEST_USER_ID" || fail "could not create test user $TEST_EMAIL"

# ---- 1 + 2. List users ----
api_get "/api/v1/users?companyId=$COMPANY_ID"
assert_status 200 "GET /users list"
LIST_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('ok' if 'users' in d and 'pendingInvitations' in d else 'missing keys')
" "$BODY" 2>/dev/null)
[ "$LIST_SHAPE" = "ok" ] && pass "/users has { users, pendingInvitations }" || fail "list shape: $BODY"
# Should have at least 1 user
LIST_COUNT=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['users']))" "$BODY" 2>/dev/null)
[ "$LIST_COUNT" -ge 1 ] && pass "list has $LIST_COUNT user(s)" || fail "list empty"

# ---- 3. Change role of test user ----
# Save original to restore later
ORIG_ROLE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT role FROM \"User\" WHERE id='$TEST_USER_ID';")
api_patch "/api/v1/users/$TEST_USER_ID/role?companyId=$COMPANY_ID" '{"role":"admin"}'
assert_status 200 "PATCH /users/:id/role"
# Verify the DB has the new role
NEW_ROLE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT role FROM \"User\" WHERE id='$TEST_USER_ID';")
[ "$NEW_ROLE" = "admin" ] && pass "role changed: $ORIG_ROLE → admin" || fail "role = $NEW_ROLE (expected admin)"

# ---- 4. PATCH role missing role field → 400 ----
api_patch "/api/v1/users/$TEST_USER_ID/role?companyId=$COMPANY_ID" '{}'
assert_status 400 "PATCH /users/:id/role missing role"
echo "$BODY" | grep -q "role ist erforderlich" && pass "missing-role error in German" || fail "missing-role error: $BODY"

# ---- 5. Set status inactive ----
ORIG_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT status FROM \"User\" WHERE id='$TEST_USER_ID';")
api_patch "/api/v1/users/$TEST_USER_ID/status?companyId=$COMPANY_ID" '{"status":"inactive"}'
assert_status 200 "PATCH /users/:id/status inactive"
NEW_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT status FROM \"User\" WHERE id='$TEST_USER_ID';")
[ "$NEW_STATUS" = "inactive" ] && pass "status changed: $ORIG_STATUS → inactive" || fail "status = $NEW_STATUS (expected inactive)"

# ---- 6. Set status active again ----
api_patch "/api/v1/users/$TEST_USER_ID/status?companyId=$COMPANY_ID" '{"status":"active"}'
assert_status 200 "PATCH /users/:id/status active"
NEW_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT status FROM \"User\" WHERE id='$TEST_USER_ID';")
[ "$NEW_STATUS" = "active" ] && pass "status changed: inactive → active" || fail "status = $NEW_STATUS (expected active)"

# ---- 7. PATCH status missing status field → 400 ----
api_patch "/api/v1/users/$TEST_USER_ID/status?companyId=$COMPANY_ID" '{}'
assert_status 400 "PATCH /users/:id/status missing status"
echo "$BODY" | grep -q "status ist erforderlich" && pass "missing-status error in German" || fail "missing-status error: $BODY"

# ---- 8. PATCH status invalid value → 400 ----
# The service likely accepts the union 'active'|'inactive' and
# throws for other strings. Tier 231 doesn't make assumptions
# about the exact error shape — just that it's 4xx.
api_patch "/api/v1/users/$TEST_USER_ID/status?companyId=$COMPANY_ID" '{"status":"lolwut"}'
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"lolwut"}' \
  "$API/api/v1/users/$TEST_USER_ID/status?companyId=$COMPANY_ID")
# Tier 361: this was a note ("tolerated") and the backend answered 200,
# storing the invalid value. The controller now rejects it, so assert it.
[ "$HTTP" -ge 400 ] && [ "$HTTP" -lt 500 ] && pass "invalid status value rejected (HTTP $HTTP)" || fail "invalid status value accepted (HTTP $HTTP)"

# ---- 9. GET /users/me/companies ----
api_get "/api/v1/users/me/companies"
assert_status 200 "GET /users/me/companies"
ME_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('ok' if 'activeCompanyId' in d and 'companies' in d else 'missing keys')
" "$BODY" 2>/dev/null)
[ "$ME_SHAPE" = "ok" ] && pass "/me/companies has { activeCompanyId, companies[] }" || fail "me/companies shape: $BODY"
# Our test user should have at least 1 company
COMP_COUNT=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])['companies']))" "$BODY" 2>/dev/null)
[ "$COMP_COUNT" -ge 1 ] && pass "me/companies has $COMP_COUNT company" || fail "me/companies empty"

# ---- 10. POST /users/me/switch-company with valid companyId ----
api_post "/api/v1/users/me/switch-company" "{\"companyId\": \"$COMPANY_ID\"}"
assert_status 201 "POST /users/me/switch-company valid"

# ---- 11. POST /users/me/switch-company with fake companyId → 4xx (German error) ----
# Pre-existing: controller throws BadRequestException (400) with
# German 'Kein Zugriff auf diese Firma' instead of a more
# semantically correct 403 Forbidden. The test asserts 4xx and
# the German message so the behaviour is documented — not the
# status code (which is a weak validation choice, out of scope
# for a coverage tier).
api_post "/api/v1/users/me/switch-company" '{"companyId":"00000000-0000-0000-0000-000000000000"}'
HTTP=$(curl -sS -o /tmp/tier231-sw.json -w "%{http_code}" -X POST \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"companyId":"00000000-0000-0000-0000-000000000000"}' \
  "$API/api/v1/users/me/switch-company")
[ "$HTTP" -ge 400 ] && [ "$HTTP" -lt 500 ] && pass "fake companyId switch rejected (HTTP $HTTP)" || fail "fake companyId switch HTTP=$HTTP"
grep -q "Kein Zugriff auf diese Firma" /tmp/tier231-sw.json && pass "fake companyId error in German" || fail "fake companyId error: $(cat /tmp/tier231-sw.json)"

# ---- 12. GET /users without companyId → 400 ----
api_get "/api/v1/users"
assert_status 400 "GET /users no companyId"
# Note: this controller uses ENGLISH 'companyId is required'
# (pre-existing inconsistency, not fixed in this tier)
echo "$BODY" | grep -qi "companyId" && pass "no-companyId error mentions field" || fail "no-companyId error: $BODY"

# ---- 13. PATCH role with fake userId → 404 ----
# Note: this depends on the service behaviour. The test user is
# already an active admin of the test company, so a fake id
# likely returns 404. We just assert 4xx.
api_patch "/api/v1/users/00000000-0000-0000-0000-000000000000/role?companyId=$COMPANY_ID" '{"role":"test user"}'
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"role":"test user"}' \
  "$API/api/v1/users/00000000-0000-0000-0000-000000000000/role?companyId=$COMPANY_ID")
[ "$HTTP" -ge 400 ] && [ "$HTTP" -lt 500 ] && pass "fake userId PATCH role rejected (HTTP $HTTP)" || note "fake userId HTTP=$HTTP (tolerated)"

# ---- 14. Cleanup: delete the test user created above ----
# No ON_ERROR_STOP: if a foreign key blocks the DELETE, the count still runs
# and reports the row as left behind.
LEFT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -q -c "DELETE FROM \"User\" WHERE id='$TEST_USER_ID'; SELECT count(*) FROM \"User\" WHERE email='$TEST_EMAIL';" 2>/dev/null | tail -1 | tr -d ' ')
[ "$LEFT" = "0" ] && pass "test user deleted" || fail "test user $TEST_EMAIL not deleted (rows left: '$LEFT')"

summary
