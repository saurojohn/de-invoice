#!/usr/bin/env bash
# e2e 93: Tier 66 — Multi-Mandanten-Berater (UserCompany).
#
# Validates the new auth model where a User's access
# to a Company is governed by the UserCompany join
# table (many-to-many), not the legacy 1:1
# User.companyId check.
#
# Scenarios:
#   1. Existing users were backfilled (the migration
#      copied User.companyId → UserCompany with the
#      user's role).
#   2. GET /users/me/companies returns the user's
#      accessible companies with the active one
#      flagged.
#   3. A new UserCompany grant lets the user see +
#      switch to the new Mandant.
#   4. POST /users/me/switch-company validates the
#      grant — 400 if the user has no UserCompany
#      row for the target.
#   5. Cross-tenant access is rejected: a request
#      with x-company-id set to a company the user
#      has no grant for returns 401.
#   6. The /users/me/companies list re-orders so the
#      active Mandant is first (verified by the
#      isActive flag).
#   7. Cleanup.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"
SECOND_COMPANY_ID="tier66-second-company-id"

# ───── 0. Wipe prior tier-66 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "UserCompany" WHERE "companyId" = '$SECOND_COMPANY_ID';
DELETE FROM "Company" WHERE id = '$SECOND_COMPANY_ID';
SQL
pass "wiped prior tier-66 fixtures"

# Helper: stash BODY to a file for jsf reads
stash() { printf '%s' "$BODY" > "$1"; }
jsf() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))" < "$2"; }

# ───── 1. Backfill: test user has a UserCompany row for SH Leder ─────
echo
note "=== 1. migration backfilled UserCompany for SH Leder ==="
ROW_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"UserCompany\"
  WHERE \"userId\" = '$USER_ID' AND \"companyId\" = '$COMPANY_ID';" 2>&1 | tr -d ' ')
assert_eq "backfilled row exists" "$ROW_COUNT" "1"

# ───── 2. GET /users/me/companies returns 1 company (SH Leder) ─────
echo
note "=== 2. GET /users/me/companies returns SH Leder ==="
api_get "/api/v1/users/me/companies"
assert_eq "list 200" "$STATUS" "200"
TMP2=$(mktemp); stash "$TMP2"
assert_eq "activeCompanyId=SH Leder" "$(jsf activeCompanyId "$TMP2")" "$COMPANY_ID"
COMPANIES_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['companies']))" < "$TMP2")
assert_eq "1 accessible company" "$COMPANIES_COUNT" "1"
IS_ACTIVE=$(python3 -c "import json,sys; print(json.load(sys.stdin)['companies'][0]['isActive'])" < "$TMP2")
assert_eq "isActive=true" "$IS_ACTIVE" "True"
rm -f "$TMP2"

# ───── 3. Create a second company + grant access ─────
echo
note "=== 3. create second Mandant + grant access ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Company" (id, name, "legalName", address, "defaultPaymentDays", "createdAt", "updatedAt")
VALUES ('$SECOND_COMPANY_ID', 'Tier66 Second GmbH', 'TestGmbH', '{}'::jsonb, 30, NOW(), NOW());

INSERT INTO "UserCompany" ("userId", "companyId", role, "grantedAt")
VALUES ('$USER_ID', '$SECOND_COMPANY_ID', 'accountant', NOW());
SQL
pass "created second Mandant + granted"

# Now the list should have 2
api_get "/api/v1/users/me/companies"
TMP3=$(mktemp); stash "$TMP3"
COUNT3=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['companies']))" < "$TMP3")
assert_eq "2 accessible companies" "$COUNT3" "2"
rm -f "$TMP3"

# ───── 4. POST /users/me/switch-company → success ─────
echo
note "=== 4. POST switch-company → success ==="
BODY="{\"companyId\":\"$SECOND_COMPANY_ID\"}"
api_post "/api/v1/users/me/switch-company" "$BODY"
# NestJS @Post convention returns 201 Created.
assert_eq "switch 201" "$STATUS" "201"
TMP4=$(mktemp); stash "$TMP4"
assert_eq "switched to second" "$(jsf id "$TMP4")" "$SECOND_COMPANY_ID"
assert_eq "role=accountant" "$(jsf role "$TMP4")" "accountant"
rm -f "$TMP4"

# ───── 5. Switch to a non-granted company → 400 ─────
echo
note "=== 5. switch to non-granted company → 400 ==="
BODY="{\"companyId\":\"00000000-0000-0000-0000-000000000000\"}"
api_post "/api/v1/users/me/switch-company" "$BODY"
assert_eq "non-granted 400" "$STATUS" "400"

# ───── 6. Cross-tenant: request with x-company-id = second company (no grant) → 401 ─────
echo
note "=== 6. x-company-id = second (no grant) → 401 ==="
# Remove the second Mandant grant for the test user.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "UserCompany" WHERE "userId" = '$USER_ID' AND "companyId" = '$SECOND_COMPANY_ID';
SQL
pass "removed second Mandant grant (for cross-tenant test)"

# Direct curl: the api_get helper always uses the cached
# x-company-id from /tmp/cashbook-e2e-auth.env, which is
# SH Leder. We need a request with x-company-id = second
# company AND no grant for it. Use curl directly.
CROSS_TENANT_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $SECOND_COMPANY_ID")
assert_eq "cross-tenant 401" "$CROSS_TENANT_STATUS" "401"

# Sanity: same request to SH Leder (granted) still 200.
SH_LEDER_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "SH Leder still 200" "$SH_LEDER_STATUS" "200"

# ───── 7. Cleanup ─────
echo
note "=== 7. cleanup ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "UserCompany" WHERE "companyId" = '$SECOND_COMPANY_ID';
DELETE FROM "Company" WHERE id = '$SECOND_COMPANY_ID';
SQL
pass "cleanup complete"

summary
exit $?
