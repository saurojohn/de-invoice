#!/bin/bash
# Tier 780 — 2FA is the caller's own, and its second step needs the password
#
# A sweep of the routes a stranger reaches (login, registration, the 2FA
# step, password reset, invitations, the portals) found:
#   - /auth/2fa/setup, /enable, /disable and /status read the `x-user-id`
#     header. With a session the guard ignores that header, so it was the
#     client's word: an attacker's own session with another company's user id
#     in it enabled 2FA on that user's account, with the attacker's secret.
#     And a browser in production sends no such header — setup answered 401.
#   - /auth/2fa/verify took { email, code }: the e-mail and the code were a
#     login, the password never needed. With the planted secret the attacker
#     was signed in as the victim (201 + session), measured.
# Login now hands out a challenge (five minutes, five wrong codes), and verify
# takes it instead of the e-mail.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-485-$(date +%s%N | cut -c1-13)"
PW="Tier780-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
totp() { # base32 secret → the current code
  python3 -c "
import sys, time, hmac, hashlib, base64, struct
s = sys.argv[1]; k = base64.b32decode(s + '=' * (-len(s) % 8))
d = hmac.new(k, struct.pack('>Q', int(time.time() // 30)), hashlib.sha1).digest(); o = d[-1] & 15
print('%06d' % ((struct.unpack('>I', d[o:o + 4])[0] & 0x7fffffff) % 1000000))" "$1"
}
field() { python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1') or '')
except Exception: print('')"; }
post() { # path body [extra curl args] → "status body"
  local p="$1" b="$2"; shift 2
  curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API$p" -H "Content-Type: application/json" "$@" -d "$b"
}
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
reg() { # suffix → "user company token"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"$PW\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user']['companyId'], d['sessionToken'])" 2>/dev/null
}
read -r V VC VT < <(reg victim)
read -r M MC MT < <(reg attacker)
VE="$TAG-victim@example.test"; ME="$TAG-attacker@example.test"
[[ -n "${VT:-}" && -n "${MT:-}" ]] && pass "fixture: two companies, each with its admin's session" || { fail "register"; summary; exit 1; }
MS=(-H "Authorization: Bearer $MT" -H "x-company-id: $MC")

note "=== setup and enable act on the signed-in user, whatever x-user-id says ==="
st=$(post /api/v1/auth/2fa/setup '{}' "${MS[@]}" -H "x-user-id: $V")
SECRET=$(field secret < "$D/out")
assert_eq "setup with the attacker's session and the victim's id: 201" "$st" "201"
[[ "$(field otpauthUrl < "$D/out")" == *"$TAG-attacker%40example.test"* ]] && pass "…the secret is for the attacker's own account (was the victim's)" || fail "setup acted for: $(field otpauthUrl < "$D/out")"
st=$(post /api/v1/auth/2fa/enable "{\"code\":\"$(totp "$SECRET")\"}" "${MS[@]}" -H "x-user-id: $V")
assert_eq "enable: 201" "$st" "201"
assert_eq "the victim's account has no 2FA (it was enabled with the attacker's secret)" "$(q "select \"twoFactorEnabled\" from \"User\" where id='$V'")" "f"
assert_eq "…the attacker's has" "$(q "select \"twoFactorEnabled\" from \"User\" where id='$M'")" "t"
post /api/v1/auth/2fa/status '{}' "${MS[@]}" >/dev/null
assert_eq "status with the session alone: the caller's state (was 'off' for everyone)" "$(field enabled < "$D/out")" "True"
st=$(post /api/v1/auth/2fa/setup '{}' -H "Authorization: Bearer $VT" -H "x-company-id: $VC")
assert_eq "setup with the session alone, as a browser sends it: 201 (was 401)" "$st" "201"

note "=== the 2FA step needs the password step ==="
st=$(post /api/v1/auth/2fa/verify "{\"email\":\"$ME\",\"code\":\"$(totp "$SECRET")\"}")
assert_eq "e-mail and a valid code, no password: 401 (was 201 with a session)" "$st" "401"
[[ "$(field sessionToken < "$D/out")" == "" ]] && pass "…and no session" || fail "a session without the password"
assert_eq "…the message asks for the password" "$(field message < "$D/out")" "Die Anmeldung ist abgelaufen. Bitte melden Sie sich erneut mit Ihrem Passwort an."
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$(printf 'a%.0s' {1..64})\",\"code\":\"$(totp "$SECRET")\"}")
assert_eq "a made-up challenge: 401" "$st" "401"

post /api/v1/auth/login "{\"email\":\"$ME\",\"password\":\"$PW\"}" >/dev/null
CH=$(field twoFactorToken < "$D/out")
assert_eq "the password step hands out a challenge" "${#CH}" "64"
[[ "$(field sessionToken < "$D/out")" == "" ]] && pass "…and no session" || fail "password alone gave a session"
for i in 1 2 3 4 5; do st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"000000\"}"); done
assert_eq "five wrong codes: 401" "$st" "401"
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$(totp "$SECRET")\"}")
assert_eq "…then the right code on that challenge: 401, the password is asked again" "$st" "401"

post /api/v1/auth/login "{\"email\":\"$ME\",\"password\":\"$PW\"}" >/dev/null
CH=$(field twoFactorToken < "$D/out")
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$(totp "$SECRET")\"}")
S2=$(field sessionToken < "$D/out")
assert_eq "password, then the code: 201" "$st" "201"
assert_eq "…a session of the user who gave the password" "$(field id < "$D/out")" "$M"
assert_eq "…that works" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/auth/me" -H "Authorization: Bearer $S2" -H "x-company-id: $MC")" "200"
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$(totp "$SECRET")\"}")
assert_eq "the same challenge a second time: 401" "$st" "401"

summary
