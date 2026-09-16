#!/bin/bash
# Tier 400 — login mints a session; the cookie is the credential
#
# Measured before the fix (HANDOFF §9 item 10): `x-user-id` WAS the credential.
# The guard looked the id up, checked UserCompany for `x-company-id`, and let the
# request through — so knowing a user's UUID was enough to be that user, and a
# password check protected nothing that came after it. Measured on the old code:
#   POST /auth/login          → no Set-Cookie, no sessionToken in the body
#   GET  /customers with only a cookie / Bearer token → 401
#   POST /auth/logout         → 404 (the route did not exist)
# So there was no credential to steal, revoke or expire — only an id to guess.
#
# The legacy header still works here on purpose: the stack runs with
# ALLOW_HEADER_AUTH on (its default), which is how the other ~300 specs keep
# passing. Production sets ALLOW_HEADER_AUTH=0; that path is asserted statically
# at the end, the same way the @Throttle limits are (THROTTLE_DISABLED=1 in CI).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-190-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

# A throwaway company, so nothing here depends on the seed user's state.
REG=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier400-e2e\",\"companyName\":\"$TAG GmbH\"}")
read -r U C < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${U:-}" && -n "${C:-}" ]] && pass "fixture: a fresh user + company" || { fail "fixture: register — $REG"; summary; exit 1; }

note "=== 1. login answers with a session ==="
HDRS=$(mktemp); LOGIN=$(curl -sS -D "$HDRS" -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier400-e2e\"}")
TOKEN=$(json_field "$LOGIN" sessionToken)
SET_COOKIE=$(grep -i '^set-cookie:' "$HDRS" | tr -d '\r')
[[ ${#TOKEN} -eq 64 ]] && pass "sessionToken is 64 hex chars (was absent)" || fail "sessionToken length ${#TOKEN} — $LOGIN"
[[ "$TOKEN" != "$U" ]] && pass "…and is not the user id" || fail "the token is the user id"
[[ -n "$(json_field "$LOGIN" sessionExpiresAt)" ]] && pass "sessionExpiresAt is returned" || fail "no sessionExpiresAt"
[[ "$SET_COOKIE" == *"de_session="* ]] && pass "Set-Cookie: de_session (was: no cookie at all)" || fail "no session cookie — $SET_COOKIE"
[[ "$SET_COOKIE" == *HttpOnly* ]] && pass "…HttpOnly, so scripts cannot read it" || fail "…cookie is not HttpOnly: $SET_COOKIE"
[[ "$SET_COOKIE" == *"SameSite=Lax"* ]] && pass "…SameSite=Lax" || fail "…no SameSite: $SET_COOKIE"
[[ "$SET_COOKIE" == *"Path=/"* ]] && pass "…Path=/" || fail "…no Path: $SET_COOKIE"
# 30 days, sliding — the operator's choice (Tier 399/400).
MAXAGE=$(echo "$SET_COOKIE" | sed -n 's/.*Max-Age=\([0-9]*\).*/\1/p')
assert_eq "…Max-Age is 30 days" "$MAXAGE" "2592000"
assert_eq "…one session row for the user" "$(sql "SELECT count(*) FROM \"UserSession\" WHERE \"userId\" = '$U' AND \"revokedAt\" IS NULL;")" "1"
assert_eq "…the token is stored, not the password" "$(sql "SELECT count(*) FROM \"UserSession\" WHERE token = '$TOKEN';")" "1"
rm -f "$HDRS"

note "=== 2. the session authenticates (no x-user-id anywhere) ==="
BY_COOKIE() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Cookie: de_session=$TOKEN" \
    -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
BY_COOKIE GET "/api/v1/customers?companyId=$C"
assert_status 200 "cookie alone reaches a protected route (was 401)"
RESP=$(curl -sS -w "\n%{http_code}" "$API/api/v1/customers?companyId=$C" -H "Authorization: Bearer $TOKEN" -H "x-company-id: $C")
STATUS=$(echo "$RESP" | tail -n1)
assert_status 200 "Authorization: Bearer works too, for non-browser clients (was 401)"

note "=== 3. a session that is not one is refused ==="
BOGUS=$(curl -sS -w "\n%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "Cookie: de_session=$(printf 'f%.0s' {1..64})" -H "x-company-id: $C")
STATUS=$(echo "$BOGUS" | tail -n1); BODY=$(echo "$BOGUS" | sed '$d')
assert_status 401 "an unknown token is refused"
# A present-but-invalid session must NOT fall through to the header path.
STOLEN=$(curl -sS -w "\n%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "Cookie: de_session=$(printf 'f%.0s' {1..64})" -H "x-user-id: $U" -H "x-company-id: $C")
STATUS=$(echo "$STOLEN" | tail -n1)
assert_status 401 "…and a bad session does not fall back to x-user-id"
# The session says who you are; it does not say which Mandant — that check stays.
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Cookie: de_session=$TOKEN" -H "x-company-id: $COMPANY_ID")
assert_status 401 "a valid session claiming a company it is not a member of"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Cookie: de_session=$TOKEN" -H "x-company-id: $C")
assert_status 403 "…and a session cannot widen its scope via the query companyId"

note "=== 4. writes are attributed to the session's user ==="
BY_COOKIE POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"
assert_status 201 "create a customer with the cookie only"
CUST=$(json_field "$BODY" id)
assert_eq "audit row carries the session user" \
  "$(sql "SELECT \"userId\" FROM \"AuditLog\" WHERE \"entityId\" = '$CUST' AND action = 'customer.created' LIMIT 1;")" "$U"
assert_eq "…and the company" \
  "$(sql "SELECT \"companyId\" FROM \"AuditLog\" WHERE \"entityId\" = '$CUST' AND action = 'customer.created' LIMIT 1;")" "$C"

note "=== 5. expiry and revocation ==="
# A second login: revoking one session must not touch the other.
TOKEN2=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier400-e2e\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))" 2>/dev/null)
[[ ${#TOKEN2} -eq 64 && "$TOKEN2" != "$TOKEN" ]] && pass "a second login mints a different session" || fail "second login: '$TOKEN2'"
OUT=$(curl -sS -D - -o /dev/null -w "\n%{http_code}" -X POST "$API/api/v1/auth/logout" -H "Cookie: de_session=$TOKEN")
STATUS=$(echo "$OUT" | tail -n1)
assert_status 200 "POST /auth/logout (the route did not exist)"
[[ "$(echo "$OUT" | tr -d '\r' | grep -i '^set-cookie:')" == *"Max-Age=0"* ]] && pass "…clears the cookie" || fail "…no clearing cookie"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" -H "Cookie: de_session=$TOKEN" -H "x-company-id: $C")
assert_status 401 "…the logged-out session is dead"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" -H "Cookie: de_session=$TOKEN2" -H "x-company-id: $C")
assert_status 200 "…the other session of the same user still works"
assert_eq "…revokedAt is recorded" "$(sql "SELECT count(*) FROM \"UserSession\" WHERE token = '$TOKEN' AND \"revokedAt\" IS NOT NULL;")" "1"
# Expiry is enforced on read, not by a sweeper.
sql "UPDATE \"UserSession\" SET \"expiresAt\" = now() - interval '1 day' WHERE token = '$TOKEN2';" >/dev/null
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" -H "Cookie: de_session=$TOKEN2" -H "x-company-id: $C")
assert_status 401 "an expired session is refused"

note "=== 6. the production setting (static — the stack runs with the flag on) ==="
GUARD="$SCRIPT_DIR/../src/auth/header-auth.guard.ts"
grep -q "legacyHeaderAuthAllowed()" "$GUARD" \
  && pass "HeaderAuthGuard gates x-user-id behind ALLOW_HEADER_AUTH" || fail "the guard accepts x-user-id unconditionally"
grep -q "ALLOW_HEADER_AUTH !== '0'" "$SCRIPT_DIR/../src/auth/auth-mode.ts" \
  && pass "ALLOW_HEADER_AUTH=0 turns the legacy header off" || fail "auth-mode.ts does not read the flag"
grep -q "legacyHeaderAuthAllowed()" "$SCRIPT_DIR/../src/auth/soft-auth.guard.ts" \
  && pass "SoftAuthGuard gates it too" || fail "SoftAuthGuard still trusts x-user-id"

summary; exit $?
