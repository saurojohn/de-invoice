#!/bin/bash
# Tier 402 — the production auth mode, measured instead of asserted statically
#
# Tiers 400-401 put the app on session cookies but left the legacy `x-user-id`
# header enabled, because ~300 specs authenticate with it. Production runs
# `ALLOW_HEADER_AUTH=0`, and until now nothing in CI ever started the app that
# way: spec 190 could only grep the guards for the flag, the same way the
# @Throttle limits are checked (THROTTLE_DISABLED=1 in CI). A grep cannot catch
# a route that reads `x-user-id` directly, a login path that mints no session,
# or a public route that stops working — and there were 14 such controllers
# when Tier 399 counted them.
#
# So this spec restarts the backend the way production runs it, measures, and
# restarts it back. It is numbered last on purpose (the glob runs in sorted
# order) and restores the backend from an EXIT trap, so a failed assertion
# cannot leave the rest of the suite talking to a backend in the wrong mode.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-191-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

# ---- restart helpers -------------------------------------------------------
# Same shape as e2e/20 (which restarts the backend for VIES_MOCK): kill by
# port, use the canonical wrapper so FRONTEND_URL and friends survive, and wait
# on /health/deep rather than /health — the latter answers before Nest has
# finished wiring the modules.
restart_backend() { # extra env assignments, e.g. "ALLOW_HEADER_AUTH=0"
  local extra="$1" i DEEP
  lsof -ti:3001 | xargs kill -9 2>/dev/null
  sleep 1
  cd "$SCRIPT_DIR/.."
  # shellcheck disable=SC2086
  nohup env VIES_MOCK=1 THROTTLE_DISABLED=1 $extra bash scripts/start-backend.sh \
    > /tmp/backend.log 2>&1 &
  for i in $(seq 1 60); do
    sleep 1
    DEEP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 1 \
      "$API/api/v1/health/deep" 2>/dev/null)
    [ "$DEEP" = "200" ] && return 0
  done
  return 1
}

RESTORED=0
restore() {
  [[ "$RESTORED" == "1" ]] && return
  RESTORED=1
  # Every later spec (and, in CI, nothing — this one runs last) needs the
  # header mode back. A failure here is louder than any assertion above it.
  if restart_backend ""; then
    note "backend restored to the default auth mode"
  else
    echo "FATAL: could not restart the backend after the flag test" >&2
  fi
}
trap restore EXIT

# ---- fixtures, created while the header still works ------------------------
REG=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier402-e2e\",\"companyName\":\"$TAG GmbH\"}")
read -r U C < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${U:-}" && -n "${C:-}" ]] && pass "fixture: a user and company" || { fail "fixture: $REG"; exit 1; }

note "=== 1. with ALLOW_HEADER_AUTH=0 (what production runs) ==="
if ! restart_backend "ALLOW_HEADER_AUTH=0"; then
  fail "backend did not come up with ALLOW_HEADER_AUTH=0"
  summary; exit 1
fi
pass "backend restarted in production auth mode"

# The credential the app used to trust is now worth nothing.
RESP=$(curl -sS -w "\n%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "x-user-id: $U" -H "x-company-id: $C")
STATUS=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_status 401 "x-user-id is refused (it is 200 in CI's default mode)"
[[ "$BODY" == *"keine gültige Sitzung"* ]] && pass "…with the production message" || fail "…unexpected body: $BODY"

# A fresh login is the only way in, and it works.
LOGIN=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier402-e2e\"}")
TOKEN=$(json_field "$LOGIN" sessionToken)
assert_eq "login still mints a session" "${#TOKEN}" "64"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "Cookie: de_session=$TOKEN" -H "x-company-id: $C")
assert_status 200 "…and the cookie authenticates"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "Authorization: Bearer $TOKEN" -H "x-company-id: $C")
assert_status 200 "…so does the Bearer form"

note "=== 2. signing up still works with the flag off (Tier 401's four routes) ==="
# This is the case that would have been broken before Tier 401: a route that
# completes a login without minting a session leaves its user unable to use the
# app at all in this mode — the failure is invisible while the header works.
REG2=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier402-e2e\",\"companyName\":\"$TAG b\"}")
R_TOKEN=$(json_field "$REG2" sessionToken)
R_COMPANY=$(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user'].get('companyId') or d['company']['id'])" <<< "$REG2" 2>/dev/null)
assert_eq "register mints a session" "${#R_TOKEN}" "64"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$R_COMPANY" \
  -H "Cookie: de_session=$R_TOKEN" -H "x-company-id: $R_COMPANY")
assert_status 200 "…and the brand-new company is usable immediately"

note "=== 3. what must NOT change when the flag flips ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/health")
assert_status 200 "a public route is still public"
# @Public() routes must bypass the guard entirely, not answer 401 because the
# header they used to accept is gone. A bogus token is a 400/404 from the
# handler — anything but 401 proves the route was reached.
RESP=$(curl -sS -w "\n%{http_code}" "$API/api/v1/invitations/verify?token=nope-$TAG")
STATUS=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_status 200 "…an unauthenticated public route still reaches its handler"
[[ "$BODY" == *'"valid":false'* ]] && pass "…and answers from the handler, not the guard" \
  || fail "…unexpected body: $BODY"
# Writes are still attributed: the audit context is filled by the guard, and in
# this mode the guard only ever learns the user from the session.
CUST=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" -H "Content-Type: application/json" \
  -H "Cookie: de_session=$TOKEN" -H "x-company-id: $C" \
  -d "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}")
CID=$(json_field "$CUST" id)
assert_eq "a write under session-only auth is attributed" \
  "$(sql "SELECT \"userId\" FROM \"AuditLog\" WHERE \"entityId\" = '$CID' AND action = 'customer.created' LIMIT 1;")" "$U"

note "=== 4. and the suite gets its backend back ==="
restore
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "x-user-id: $U" -H "x-company-id: $C")
assert_status 200 "x-user-id works again in the default mode"

summary; exit $?
