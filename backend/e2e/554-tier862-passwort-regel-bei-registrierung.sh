#!/bin/bash
# Tier 862 — a registration's password is not its e-mail address
#
# Security audit (18.11.2026), item 13. The audit said the registration took
# any six characters; measured, it did not — the controller asks for 8 with
# letters and digits, as the reset, the change and the invitation do (the
# DTO's MinLength(6) is only the first gate). What it took: the e-mail address
# itself as the password, the first thing anyone tries against an account
# (201 on Tier 861). The rule's answers are pinned here too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-554-$(date +%s%N | cut -c1-13)"
reg() { # local-part password → STATUS, BODY
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2],"companyName":sys.argv[1]+" GmbH"}))' "$1" "$2")")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
msg() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get('message',''))
except Exception: print(sys.argv[1])" "$BODY"; }

reg "$TAG-a@example.test" "aaaaaa"
assert_eq "six letters: refused" "$STATUS $(msg)" "400 Passwort muss mindestens 8 Zeichen lang sein"
reg "$TAG-b@example.test" "abcdefgh"
assert_eq "eight letters, no digit: refused" "$STATUS $(msg)" "400 Passwort muss mindestens eine Zahl enthalten"
reg "$TAG-c@example.test" "12345678"
assert_eq "eight digits, no letter: refused" "$STATUS $(msg)" "400 Passwort muss mindestens einen Buchstaben enthalten"
reg "$TAG-d1@example.test" "$TAG-D1@Example.test"
assert_eq "the e-mail address as the password: refused (was 201)" "$STATUS $(msg)" "400 Das Passwort darf nicht die E-Mail-Adresse sein"
assert_eq "no account was made for any of them" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "select count(*) from \"User\" where email like '$TAG-%'")" "0"
reg "$TAG-e@example.test" "Tier862-e2e"
assert_eq "letters and digits, 8 or more: registered" "$STATUS" "201"
summary
