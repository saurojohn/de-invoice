#!/bin/bash
# Tier 782 — a user's e-mail address is the same in any case; a company needs a name
#
# The sweep of the routes a stranger reaches (Tier 780) measured: registration
# kept the address as typed and looked it up as typed, while invitations,
# password reset and the 2FA step lower-cased it —
#   - `Name@Firma.de` registered, then `name@firma.de` registered a second account
#   - forgot-password with the address as registered set no reset token
#   - login in the other case: "Invalid email or password"
# and the company name took 100 000 characters, or blanks.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TS=$(date +%s%N | cut -c1-13)
PW="Tier782-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
post() { # path body [extra] → status; body in $D/out
  local p="$1" b="$2"; shift 2
  curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API$p" -H "Content-Type: application/json" "$@" -d "$b"
}
field() { python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'): d=d.get(k) if isinstance(d,dict) else None
  print(d if d is not None else '')
except Exception: print('')" < "$D/out"; }
reg() { post /api/v1/auth/register "{\"email\":\"$1\",\"password\":\"$PW\",\"companyName\":\"$2\"}"; }

note "=== registration stores the address lower-case and takes it in any case ==="
MIXED="E2E-487-$TS-Case@Example.test"; LOWER=$(echo "$MIXED" | tr 'A-Z' 'a-z')
st=$(reg "$MIXED" "e2e-487 $TS GmbH")
U=$(field user.id); C=$(field user.companyId)
assert_eq "register with capitals: 201" "$st" "201"
assert_eq "…stored lower-case (was as typed)" "$(q "select email from \"User\" where id='$U'")" "$LOWER"
st=$(reg "$LOWER" "e2e-487 $TS zwei GmbH")
assert_eq "the same address in lower case: refused (was a second account)" "$st" "400"
assert_eq "…one account with the address" "$(q "select count(*) from \"User\" where lower(email)='$LOWER'")" "1"
st=$(post /api/v1/auth/login "{\"email\":\"$MIXED\",\"password\":\"$PW\"}")
assert_eq "login with the capitals as registered: 200" "$st" "200"
assert_eq "…as that user" "$(field id)" "$U"

note "=== an account stored with capitals before this ==="
LEG="E2E-487-$TS-Alt@Example.test"; LEG_LOWER=$(echo "$LEG" | tr 'A-Z' 'a-z')
st=$(reg "e2e-487-$TS-tmp@example.test" "e2e-487 $TS alt GmbH")
L=$(field user.id); LC=$(field user.companyId)
q "update \"User\" set email='$LEG' where id='$L'" >/dev/null
st=$(post /api/v1/auth/login "{\"email\":\"$LEG_LOWER\",\"password\":\"$PW\"}")
assert_eq "login in lower case: 200 (was 'Invalid email or password')" "$st" "200"
assert_eq "…as that user" "$(field id)" "$L"
st=$(post /api/v1/auth/login "{\"email\":\"$LEG\",\"password\":\"$PW\"}")
assert_eq "login as stored: 200" "$st" "200"
q "update \"User\" set \"passwordResetToken\"=null where id='$L'" >/dev/null
post /api/v1/auth/forgot-password "{\"email\":\"$LEG\"}" >/dev/null
assert_eq "forgot-password with the address as stored: a reset link for the account (was none)" "$(q "select \"passwordResetToken\" is not null from \"User\" where id='$L'")" "t"
st=$(reg "$LEG_LOWER" "e2e-487 $TS drei GmbH")
assert_eq "registering it in lower case: refused (was a second account)" "$st" "400"
q "update \"User\" set \"emailVerifiedAt\"=now() where id='$U'" >/dev/null  # invitations wait for a confirmed address (Tier 736)
st=$(post "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$LEG_LOWER\",\"role\":\"viewer\"}" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "inviting it in lower case: refused (was an invitation for a second account)" "$st" "400"
assert_eq "…the message says the user exists" "$(field message)" "Ein Benutzer mit dieser E-Mail-Adresse existiert bereits"

note "=== the company name ==="
LONG=$(python3 -c "print('X' * 100000)")
st=$(reg "e2e-487-$TS-long@example.test" "$LONG")
assert_eq "a name of 100 000 characters: 400 (was stored)" "$st" "400"
assert_eq "…the message" "$(field message)" "Firmenname darf höchstens 200 Zeichen lang sein"
st=$(reg "e2e-487-$TS-blank@example.test" "   ")
assert_eq "a blank name: 400 (was a company without a name)" "$st" "400"
assert_eq "…the message" "$(field message)" "Firmenname ist erforderlich"
assert_eq "…no accounts were made for either" "$(q "select count(*) from \"User\" where email in ('e2e-487-$TS-long@example.test','e2e-487-$TS-blank@example.test')")" "0"
st=$(reg "e2e-487-$TS-ok@example.test" "  Müller & Söhne GmbH  ")
assert_eq "a name with spaces around it: 201" "$st" "201"
assert_eq "…stored without them" "$(q "select name from \"Company\" where id='$(field user.companyId)'")" "Müller & Söhne GmbH"

summary
