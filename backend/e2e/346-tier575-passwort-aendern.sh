#!/bin/bash
# Tier 575 — a signed-in user can change the password
#
# There was no route for it: POST /auth/change-password → 404, and the only
# way to a new password was "Passwort vergessen" (a mail server, the mailbox).
# Now: the current password is asked for again, the new one follows the rule of
# the reset (8 characters, letters and digits), every session of the user ends
# and the caller gets a new one.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-346-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d)
OLD="Tier575-alt1"; NEW="Tier575-neu2"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"$OLD\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh user" || { fail "register"; summary; exit 1; }
login_as() { # password → status; body in $D/login
  local body="{\"email\":\"$TAG@example.test\",\"password\":\"$1\"}"
  curl -s -o "$D/login" -w '%{http_code}' -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "$body"
}
token() { python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('sessionToken',''))" "$D/login"; }
me() { curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/auth/me" -H "Authorization: Bearer $1" -H "x-company-id: $C"; }
# change TOKEN CURRENT NEW → status; body in $D/out   (the JSON is built here:
# bash 3.2 mangles escaped quotes inside a nested "$(…)")
change() {
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({k:v for k,v in (('currentPassword',sys.argv[1]),('newPassword',sys.argv[2])) if v != '-'}))" "$2" "$3")
  curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/auth/change-password" -H "Authorization: Bearer $1" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$body"
}
out() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$D/out" "$1" 2>/dev/null; }
HASH() { q "select \"passwordHash\" from \"User\" where id='$U'"; }

login_as "$OLD" >/dev/null; A=$(token)
login_as "$OLD" >/dev/null; B=$(token)
assert_eq "fixture: two sessions (two browsers)" "$(me "$A")/$(me "$B")" "200/200"
H0=$(HASH)

note "=== what is refused ==="
assert_eq "without a login: 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/change-password" -H "Content-Type: application/json" -d '{"currentPassword":"x","newPassword":"y"}')" "401"
assert_eq "the wrong current password: 400 (not 401 — the session is fine)" "$(change "$A" falsch-123 "$NEW")/$(grep -c "aktuelle Passwort" "$D/out")" "400/1"
assert_eq "…and it is on record" "$(q "select count(*) from \"AuditLog\" where \"userId\"='$U' and action='password_change_failed'")" "1"
assert_eq "a new password of 7 characters: 400" "$(change "$A" "$OLD" kurz123)" "400"
assert_eq "…without a digit: 400" "$(change "$A" "$OLD" nurbuchstaben)" "400"
assert_eq "…the same as before: 400" "$(change "$A" "$OLD" "$OLD")/$(grep -c "unterscheiden" "$D/out")" "400/1"
assert_eq "…a field missing: 400" "$(change "$A" - "$NEW")" "400"
ODD='{"currentPassword":{"$ne":""},"newPassword":["Tier575-neu2"]}'
assert_eq "…something that is not text: 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/change-password" -H "Authorization: Bearer $A" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$ODD")" "400"
assert_eq "nothing changed so far: same hash, both sessions alive" "$([[ "$(HASH)" == "$H0" ]] && echo same || echo changed)/$(me "$A")/$(me "$B")" "same/200/200"

note "=== the change ==="
assert_eq "change-password: 200" "$(change "$A" "$OLD" "$NEW")" "200"
N=$(out "d['sessionToken']")
assert_eq "…it ended both sessions and handed out a new one" "$(out "d['ok'], d['endedSessions'] >= 2, len(d['sessionToken']) >= 32")" "(True, True, True)"
assert_eq "the session it was done with is over, the other browser's too" "$(me "$A")/$(me "$B")" "401/401"
assert_eq "the new session works" "$(me "$N")" "200"
assert_eq "the stored hash is a new bcrypt hash" "$([[ "$(HASH)" != "$H0" && "$(HASH)" == \$2* ]] && echo yes || echo no)" "yes"
assert_eq "login with the old password: refused (400, as every wrong login)" "$(login_as "$OLD")" "400"
assert_eq "login with the new password: 200" "$(login_as "$NEW")" "200"
assert_eq "the change is on record, with the number of sessions it ended" "$(q "select count(*) from \"AuditLog\" where \"userId\"='$U' and action='password_changed' and (\"newData\"->>'endedSessions')::int >= 2")" "1"
assert_eq "no password in the audit trail" "$(q "select count(*) from \"AuditLog\" where \"userId\"='$U' and (coalesce(\"newData\"::text,'') like '%$NEW%' or coalesce(\"newData\"::text,'') like '%$OLD%' or coalesce(\"oldData\"::text,'') like '%Tier575%')")" "0"
rm -rf "$D"
summary
