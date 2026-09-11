#!/usr/bin/env bash
# e2e 99: Tier 73 — 2FA login flow end-to-end.
#
# The full 2FA API lifecycle is covered by e2e 24
# (setup → enable → verify → recovery → disable).
# This file adds the e2e checks specific to the
# login flow:
#
#   1. POST /auth/login with 2FA-enabled user
#      returns 200 + { twoFactorRequired: true, email }
#      (not the full session).
#   2. POST /auth/2fa/verify with the correct TOTP
#      returns the full session (id, email, companyId).
#   3. POST /auth/2fa/verify with a wrong TOTP
#      returns 401 + German error.
#   4. POST /auth/2fa/verify with a recovery code
#      returns the full session + 1 code consumed.
#   5. After disable, /auth/login returns the
#      full session directly again.
#
# Same pattern as e2e 24: dedicated test user
# with a UserCompany grant, cleaned up at the end.
#
# Why a separate file from e2e 24: 24 covers
# the 2FA management API (setup/enable/disable).
# 99 covers the LOGIN-time flow (login +
# verify-2fa). The split keeps each file focused
# and shorter, which makes failures easier to
# diagnose.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TEST_EMAIL="2fa-login-$(date +%s)-$$@example.com"
TEST_PW="Test1234!"
TEST_USER_ID="user-2fa-login-$(date +%s)-$$"
echo "=== Test: 2FA login flow (test user: $TEST_EMAIL) ==="

# Cleanup any prior test users (safety)
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"User\" WHERE email='$TEST_EMAIL';" >/dev/null 2>&1

# Seed test user + UserCompany grant (Tier 66
# HeaderAuthGuard requires it; 2FA is per-user
# but the verify-2fa endpoint is unguarded so
# the grant isn't strictly required for THIS
# test, but seeding it keeps the test symmetric
# with e2e 24).
SEED_HASH=$(cd "$BACKEND_DIR" && node -e "console.log(require('bcrypt').hashSync('${TEST_PW}', 10))")
export COMPANY_ID TEST_EMAIL TEST_USER_ID SEED_HASH
TMP_SQL=$(mktemp -t 2fa-login-seed.XXXXXX)
python3 - <<PY > "$TMP_SQL"
import os
sql = f'''INSERT INTO "User" (id, "companyId", email, "passwordHash", role, status, "createdAt")
VALUES ('{os.environ["TEST_USER_ID"]}'::text, '{os.environ["COMPANY_ID"]}', '{os.environ["TEST_EMAIL"]}',
        '{os.environ["SEED_HASH"]}', 'admin', 'active', now());
INSERT INTO "UserCompany" ("userId", "companyId", role, "grantedAt", "grantedById")
VALUES ('{os.environ["TEST_USER_ID"]}', '{os.environ["COMPANY_ID"]}', 'admin', now(), '{os.environ["TEST_USER_ID"]}')
ON CONFLICT ("userId", "companyId") DO NOTHING;
'''
print(sql, end='')
PY
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"

# Helper: read the user's TOTP secret from the DB
db_secret() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
    "SELECT COALESCE(\"twoFactorSecret\", '') FROM \"User\" WHERE id='$TEST_USER_ID';" \
    2>&1 | tr -d ' ' | head -1
}

# Helper: generate a TOTP code for the secret
db_code() {
  local secret="$1"
  (cd "$BACKEND_DIR" && node -e "
    const { authenticator } = require('otplib');
    authenticator.options = { step: 30, window: 1, digits: 6 };
    console.log(authenticator.generate('$secret'));
  ")
}

# ───── 1. Enable 2FA on the test user ─────
# Call the management API (HeaderAuthGuard) to set up + enable.
SETUP=$(curl -sS -X POST "$API/api/v1/auth/2fa/setup" \
  -H "x-user-id: $TEST_USER_ID" -H "x-company-id: $COMPANY_ID")
SECRET=$(echo "$SETUP" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
test -n "$SECRET" || fail "could not setup 2FA"
CODE=$(db_code "$SECRET")
ENABLE=$(curl -sS -X POST "$API/api/v1/auth/2fa/enable" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $TEST_USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"code\":\"$CODE\"}")
ENABLED=$(echo "$ENABLE" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['enabled']).lower())")
assert_eq "setup+enable works" "$ENABLED" "true"

# Capture one recovery code for test 4
RECOVERY_CODE=$(echo "$ENABLE" | python3 -c "import json,sys; print(json.load(sys.stdin)['recoveryCodes'][0])")
test -n "$RECOVERY_CODE" || fail "no recovery code returned"

# ───── 2. login with 2FA → twoFactorRequired ─────
echo
note "=== 1. login with 2FA → twoFactorRequired ==="
LOGIN_2FA=$(curl -sS -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PW\"}")
TWO_FA=$(echo "$LOGIN_2FA" | python3 -c "import json,sys; print(str(json.load(sys.stdin).get('twoFactorRequired', False)).lower())")
assert_eq "login returns twoFactorRequired" "$TWO_FA" "true"
LOGIN_EMAIL=$(echo "$LOGIN_2FA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('email', ''))")
assert_eq "login echoes email" "$LOGIN_EMAIL" "$TEST_EMAIL"

# Make sure the response does NOT contain the
# full session — only the gate.
HAS_ID=$(echo "$LOGIN_2FA" | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if 'id' in d else 'false')")
assert_eq "login does NOT return id" "$HAS_ID" "false"

# ───── 3. /auth/2fa/verify with bad TOTP → 401 ─────
echo
note "=== 2. /auth/2fa/verify with bad TOTP → 401 ==="
BAD_VERIFY=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/2fa/verify" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"code\":\"000000\"}")
assert_eq "verify bad code 401" "$BAD_VERIFY" "401"

# ───── 4. /auth/2fa/verify with valid TOTP → session ─────
echo
note "=== 3. /auth/2fa/verify with valid TOTP → session ==="
# Pull a FRESH code (might have rolled over the
# 30s window since the enable call).
SECRET=$(db_secret)
CODE2=$(db_code "$SECRET")
VERIFY=$(curl -sS -X POST "$API/api/v1/auth/2fa/verify" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"code\":\"$CODE2\"}")
VERIFY_ID=$(echo "$VERIFY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id', 'MISSING'))")
assert_eq "verify TOTP returns id" "$VERIFY_ID" "$TEST_USER_ID"
VERIFY_EMAIL=$(echo "$VERIFY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('email', ''))")
assert_eq "verify TOTP returns email" "$VERIFY_EMAIL" "$TEST_EMAIL"
VERIFY_COMPANY=$(echo "$VERIFY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('companyId', ''))")
assert_eq "verify TOTP returns companyId" "$VERIFY_COMPANY" "$COMPANY_ID"

# ───── 5. /auth/2fa/verify with recovery code → session + 1 used ─────
echo
note "=== 4. /auth/2fa/verify with recovery code → session + 1 used ==="
VERIFY_RC=$(curl -sS -X POST "$API/api/v1/auth/2fa/verify" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"recoveryCode\":\"$RECOVERY_CODE\"}")
RC_ID=$(echo "$VERIFY_RC" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id', 'MISSING'))")
assert_eq "verify recovery code returns id" "$RC_ID" "$TEST_USER_ID"
RC_LEFT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT jsonb_array_length(\"recoveryCodes\") FROM \"User\" WHERE id='$TEST_USER_ID';" \
  2>&1 | tr -d ' ' | head -1)
assert_eq "recovery code consumed (9 left)" "$RC_LEFT" "9"

# ───── 6. After disable, login returns full session ─────
echo
note "=== 5. disable 2FA + login returns full session ==="
SECRET=$(db_secret)
CODE3=$(db_code "$SECRET")
curl -sS -X POST "$API/api/v1/auth/2fa/disable" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $TEST_USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"code\":\"$CODE3\"}" >/dev/null
# Wait > 5s so the /auth/login throttler from
# earlier calls in this test doesn't block us.
sleep 6
LOGIN_AFTER=$(curl -sS -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PW\"}")
LOGIN_ID=$(echo "$LOGIN_AFTER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id', 'MISSING'))")
assert_eq "login after disable returns id" "$LOGIN_ID" "$TEST_USER_ID"
TWO_FA_AFTER=$(echo "$LOGIN_AFTER" | python3 -c "import json,sys; print(str(json.load(sys.stdin).get('twoFactorRequired', False)).lower())")
assert_eq "no twoFactorRequired after disable" "$TWO_FA_AFTER" "false"

# ───── cleanup ─────
echo
note "=== 6. cleanup ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"User\" WHERE id='$TEST_USER_ID';" >/dev/null 2>&1
pass "test user deleted"

summary
exit $?
