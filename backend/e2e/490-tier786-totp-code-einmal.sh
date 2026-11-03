#!/bin/bash
# Tier 786 — an authenticator code counts once
#
# The 2FA step checked a code with otplib's verify(): right or wrong, nothing
# else. With the window of ±1 step a code is right for about 90 seconds, and
# it stayed right however often it was used. Measured: the code that had just
# completed a sign-in completed a second one on a new password step (201), and
# the code that switched 2FA on switched it off again. Someone who sees a code
# — over a shoulder, through a phishing page that passes it on — had 90
# seconds to use it once more. Now the step of every accepted code is kept on
# the user (`twoFactorLastStep`), and a code is taken only for a later step.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-490-$(date +%s%N | cut -c1-13)"
PW="Tier786-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
totp() { # base32 secret, step offset → the code
  python3 -c "
import sys, time, hmac, hashlib, base64, struct
s = sys.argv[1]; k = base64.b32decode(s + '=' * (-len(s) % 8))
d = hmac.new(k, struct.pack('>Q', int(time.time() // 30) + int(sys.argv[2])), hashlib.sha1).digest(); o = d[-1] & 15
print('%06d' % ((struct.unpack('>I', d[o:o + 4])[0] & 0x7fffffff) % 1000000))" "$1" "$2"
}
field() { python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'): d=d.get(k) if isinstance(d,dict) else None
  print(d if d is not None else '')
except Exception: print('')" < "$D/out"; }
post() { # path body [extra curl args] → status; body in $D/out
  local p="$1" b="$2"; shift 2
  curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API$p" -H "Content-Type: application/json" "$@" -d "$b"
}
challenge() { post /api/v1/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" >/dev/null; field twoFactorToken; }

EMAIL="$TAG@example.test"
st=$(post /api/v1/auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"companyName\":\"$TAG GmbH\"}")
U=$(field user.id); C=$(field user.companyId); T=$(field sessionToken)
assert_eq "fixture: registered" "$st/${#T}" "201/64"
A=(-H "Authorization: Bearer $T" -H "x-company-id: $C")
post /api/v1/auth/2fa/setup '{}' "${A[@]}" >/dev/null
SECRET=$(field secret)
# The step now is s. The codes for s-1, s and s+1 are all inside the window;
# the spec uses them in that order, so a step boundary on the way only moves
# "now" forward and never makes a later code an earlier one.
C_PREV=$(totp "$SECRET" -1)
st=$(post /api/v1/auth/2fa/enable "{\"code\":\"$C_PREV\"}" "${A[@]}")
RC=$(python3 -c "import json;print(json.load(open('$D/out'))['recoveryCodes'][0])" 2>/dev/null)
assert_eq "enable with a code: 201" "$st" "201"
[[ -n "$(q "select \"twoFactorLastStep\" from \"User\" where id='$U'")" ]] && pass "…its step is kept on the user" || fail "no twoFactorLastStep after enable"

note "=== the code that switched 2FA on does not sign in ==="
CH=$(challenge)
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$C_PREV\"}")
assert_eq "the enabling code on a sign-in: 401 (was 201)" "$st" "401"
assert_eq "…the message says it was used" "$(field message)" "Dieser Code wurde bereits verwendet. Bitte warten Sie auf den nächsten Code Ihrer App."

note "=== a sign-in's code does not sign in again ==="
C_NOW=$(totp "$SECRET" 0)
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$C_NOW\"}")
assert_eq "the current code: 201, signed in" "$st/$(field id)" "201/$U"
CH=$(challenge)
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$C_NOW\"}")
assert_eq "the same code on a new password step: 401 (was 201)" "$st" "401"
[[ -z "$(field sessionToken)" ]] && pass "…and no session" || fail "a second session from one code"
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"$C_PREV\"}")
assert_eq "an older code, still in the window: 401" "$st" "401"
st=$(post /api/v1/auth/2fa/verify "{\"twoFactorToken\":\"$CH\",\"code\":\"000000\"}")
assert_eq "a wrong code: 401" "$st/$(field message)" "401/Code ungültig"

note "=== the next code, sent twice at once on two password steps ==="
CH1=$(challenge); CH2=$(challenge)
C_NEXT=$(totp "$SECRET" 1)
python3 - "$API" "$CH1" "$CH2" "$C_NEXT" > "$D/burst" <<'PY'
import json, sys, threading, urllib.request, urllib.error
api, ch1, ch2, code = sys.argv[1:5]
out = []
def go(ch):
    req = urllib.request.Request(api + "/api/v1/auth/2fa/verify", method="POST",
        data=json.dumps({"twoFactorToken": ch, "code": code}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: out.append(r.status)
    except urllib.error.HTTPError as e: out.append(e.code)
ts = [threading.Thread(target=go, args=(c,)) for c in (ch1, ch2)]
[t.start() for t in ts]; [t.join() for t in ts]
print(" ".join(str(s) for s in sorted(out)))
PY
assert_eq "one of the two signs in, the other is refused" "$(cat "$D/burst")" "201 401"

note "=== switching off needs a code not used before ==="
st=$(post /api/v1/auth/2fa/disable "{\"code\":\"$C_NEXT\"}" "${A[@]}")
assert_eq "disable with the code the sign-in used: 401 (was 201)" "$st" "401"
assert_eq "…2FA stays on" "$(q "select \"twoFactorEnabled\" from \"User\" where id='$U'")" "t"
st=$(post /api/v1/auth/2fa/disable "{\"recoveryCode\":\"$RC\"}" "${A[@]}")
assert_eq "a recovery code switches it off" "$st/$(q "select \"twoFactorEnabled\" from \"User\" where id='$U'")" "201/f"

summary
