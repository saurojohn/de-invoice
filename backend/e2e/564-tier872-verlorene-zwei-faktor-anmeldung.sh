#!/bin/bash
# Tier 872 — a lost second factor can be taken away: by an administrator, or on the server
#
# Tier 861 made production companies ask their administrators for 2FA. There
# was no way back for someone who lost the phone and the recovery codes — no
# administrator could reset a member's 2FA, and the last administrator of a
# company was locked out of it for good, short of editing the database.
#
# Now POST /users/:id/two-factor/reset (an administrator, a member of the
# company, not oneself) and `node dist/cli/reset-two-factor.js <e-mail>` on
# the server. Both end the member's sessions and are audited.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
BACKEND_DIR="$SCRIPT_DIR/.."
TAG="e2e-564-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
reg() { curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1@example.test\",\"password\":\"Tier872-e2e\",\"companyName\":\"$1 GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null; }
AS() { # user company method path [body] → STATUS, BODY
  local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2]))
except Exception: print('-')" "$BODY" "$1"; }
enable_2fa() { # user company
  AS "$1" "$2" POST /api/v1/auth/2fa/setup '{}'; local secret; secret=$(field secret)
  while (( $(date +%s) % 30 >= 25 )); do sleep 1; done
  local code; code=$(cd "$BACKEND_DIR" && node -e "const { authenticator } = require('otplib'); authenticator.options = { step: 30, window: 1, digits: 6 }; console.log(authenticator.generate('$secret'))")
  AS "$1" "$2" POST /api/v1/auth/2fa/enable "{\"code\":\"$code\"}"
}

read -r A C < <(reg "$TAG")
read -r M MC < <(reg "$TAG-member")
read -r V _ < <(reg "$TAG-viewer")
read -r O OC < <(reg "$TAG-other")
sql "insert into \"UserCompany\" (\"userId\",\"companyId\",role) values ('$M','$C','accountant'), ('$V','$C','viewer')" >/dev/null
enable_2fa "$M" "$C"
assert_eq "fixture: a member of the company with 2FA" "$STATUS $(sql "select \"twoFactorEnabled\" from \"User\" where id='$M'")" "201 t"
LOGIN=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$TAG-member@example.test\",\"password\":\"Tier872-e2e\"}")
# (a 2FA user gets a challenge, no session — make one the way the challenge would)
SESSION=$(sql "select count(*) from \"UserSession\" where \"userId\"='$M' and \"revokedAt\" is null")
[[ "$SESSION" -ge 1 ]] && pass "fixture: the member has a live session ($SESSION)" || pass "fixture: (no live session of the member's yet — $SESSION)"

note "=== 1. who may ==="
AS "$V" "$C" POST "/api/v1/users/$M/two-factor/reset?companyId=$C"
assert_eq "a viewer: refused" "$STATUS" "403"
AS "$A" "$C" POST "/api/v1/users/$A/two-factor/reset?companyId=$C"
assert_eq "oneself: refused, says where (with a code under „Sicherheit“)" "$STATUS $(field message | grep -c 'unter „Sicherheit“')" "400 1"
AS "$A" "$C" POST "/api/v1/users/$O/two-factor/reset?companyId=$C"
assert_eq "someone of another company: not found" "$STATUS" "404"
AS "$A" "$C" POST "/api/v1/users/$V/two-factor/reset?companyId=$C"
assert_eq "a member without 2FA: says so" "$STATUS $(field message | grep -c 'verwendet keine Zwei-Faktor-Anmeldung')" "400 1"

note "=== 2. the administrator resets it ==="
AS "$A" "$C" GET "/api/v1/users?companyId=$C"
AS "$A" "$C" POST "/api/v1/users/$M/two-factor/reset?companyId=$C"
assert_eq "reset (was: no way at all)" "$STATUS $(field twoFactorEnabled)" "200 False"
assert_eq "…secret and recovery codes gone" "$(sql "select \"twoFactorEnabled\" || ' ' || (\"twoFactorSecret\" is null) || ' ' || (\"recoveryCodes\" is null) from \"User\" where id='$M'")" "false true true"
assert_eq "…every session of the member ended" "$(sql "select count(*) from \"UserSession\" where \"userId\"='$M' and \"revokedAt\" is null")" "0"
assert_eq "…audited, by whom and how" "$(sql "select \"userId\" || ' ' || (\"newData\"->>'via') from \"AuditLog\" where action='two_factor_reset' and \"entityId\"='$M' order by \"createdAt\" desc limit 1")" "$A admin"
LOGIN=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$TAG-member@example.test\",\"password\":\"Tier872-e2e\"}")
assert_eq "the member signs in with the password again (no challenge)" "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(len(d.get('sessionToken','')), d.get('twoFactorRequired', False))" "$LOGIN")" "64 False"

note "=== 3. the last administrator, on the server ==="
enable_2fa "$A" "$C"
assert_eq "fixture: the administrator uses 2FA" "$(sql "select \"twoFactorEnabled\" from \"User\" where id='$A'")" "t"
OUT=$(cd "$BACKEND_DIR" && ./node_modules/.bin/ts-node -T src/cli/reset-two-factor.ts "$TAG@example.test" 2>&1 | tail -1)
assert_eq "the server's command resets it" "$(grep -c "2FA of $TAG@example.test reset" <<<"$OUT")" "1"
assert_eq "…audited as „server“, by no user" "$(sql "select coalesce(\"userId\", 'none') || ' ' || (\"newData\"->>'via') from \"AuditLog\" where action='two_factor_reset' and \"entityId\"='$A' order by \"createdAt\" desc limit 1")" "none server"
OUT=$(cd "$BACKEND_DIR" && ./node_modules/.bin/ts-node -T src/cli/reset-two-factor.ts "$TAG@example.test" 2>&1 | tail -1)
assert_eq "…a second time: nothing to reset" "$(grep -c 'has no second factor' <<<"$OUT")" "1"
OUT=$(cd "$BACKEND_DIR" && ./node_modules/.bin/ts-node -T src/cli/reset-two-factor.ts "nobody-$TAG@example.test" 2>&1; echo "rc=$?")
assert_eq "…an unknown address: says so, fails" "$(grep -c 'no user with the address' <<<"$OUT")/$(tail -1 <<<"$OUT")" "1/rc=1"
summary
