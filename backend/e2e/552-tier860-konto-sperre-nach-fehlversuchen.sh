#!/bin/bash
# Tier 860 — ten wrong passwords lock the account, wherever they come from
#
# Security audit (18.11.2026), item 7. The login counted failures per client
# address, in memory: five from one address locked that address for 15
# minutes. Guesses spread over many addresses (a botnet, rotating proxies)
# were never stopped — measured here: ten wrong passwords for one account from
# ten addresses, then the right one, and it signed in. A restart forgot every
# count.
#
# Now the account counts in the database: ten wrong passwords within 15
# minutes lock it for 15 minutes. Only the right password learns of the lock;
# a wrong one gets the answer every wrong password and every unknown address
# gets, so the lock tells nobody which addresses exist.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-552-$(date +%s%N | cut -c1-13)"
EMAIL="$TAG@example.test"; PASS="Tier860-richtig"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
N=0
attempt() { # email password → STATUS, BODY; from an address of its own each time
  N=$((N + 1))
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 198.51.100.$((N % 250 + 1))" \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2")")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
msg() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get('message',''))
except Exception: print(sys.argv[1])" "$BODY"; }

REG=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"companyName\":\"$TAG GmbH\"}")
U=$(python3 -c "import sys,json;print(json.load(sys.stdin)['user']['id'])" <<<"$REG" 2>/dev/null)
[[ -n "$U" ]] && pass "fixture: an account" || { fail "register: $REG"; summary; exit 1; }

note "=== 1. ten wrong passwords from ten addresses ==="
attempt "nobody-$TAG@example.test" "irgendwas"; UNKNOWN="$STATUS $(msg)"
for i in $(seq 1 9); do attempt "$EMAIL" "falsch-$i"; done
assert_eq "nine: the usual answer, not locked yet" "$STATUS $(msg) / $(sql "select \"failedLoginCount\", \"loginLockedUntil\" is null from \"User\" where id='$U'")" \
  "$UNKNOWN / 9|t"
attempt "$EMAIL" "falsch-10"
assert_eq "the tenth: the same answer as an unknown address (nothing to learn from it)" "$STATUS $(msg)" "$UNKNOWN"
assert_eq "…and the account is locked for 15 minutes" \
  "$(sql "select round(extract(epoch from (\"loginLockedUntil\" - now())) / 60) from \"User\" where id='$U'")" "15"
assert_eq "…written to the audit log, with the count" \
  "$(sql "select count(*) || ' ' || coalesce(max(\"newData\"->>'failedLogins'), '-') from \"AuditLog\" where \"userId\"='$U' and action='login_account_locked'")" "1 10"

note "=== 2. while locked ==="
attempt "$EMAIL" "falsch-11"
assert_eq "a wrong password: still the usual answer" "$STATUS $(msg)" "$UNKNOWN"
assert_eq "…the lock is not made longer" \
  "$(sql "select round(extract(epoch from (\"loginLockedUntil\" - now())) / 60) from \"User\" where id='$U'")" "15"
attempt "$EMAIL" "$PASS"
assert_eq "the right password: refused, it says until when (was: signed in)" \
  "$STATUS $(msg | grep -cE '^Dieses Konto ist nach zu vielen fehlgeschlagenen Anmeldeversuchen bis [0-9]{2}:[0-9]{2} Uhr gesperrt')" "400 1"
assert_eq "…no session for it" "$(json_field "$BODY" sessionToken)" ""
assert_eq "…and the refused login is in the audit log" \
  "$(sql "select count(*) from \"AuditLog\" where \"userId\"='$U' and action='login_blocked_account_locked'")" "1"

note "=== 3. after the lock ==="
sql "update \"User\" set \"loginLockedUntil\" = now() - interval '1 second' where id='$U'" >/dev/null
attempt "$EMAIL" "$PASS"
assert_eq "the right password signs in again" "$STATUS $(json_field "$BODY" sessionToken | awk '{print length($0)}')" "200 64"
assert_eq "…and the count starts over" \
  "$(sql "select \"failedLoginCount\" || ' ' || (\"failedLoginFirstAt\" is null) || ' ' || (\"loginLockedUntil\" is null) from \"User\" where id='$U'")" "0 true true"

note "=== 4. failures older than 15 minutes do not count ==="
sql "update \"User\" set \"failedLoginCount\" = 9, \"failedLoginFirstAt\" = now() - interval '16 minutes' where id='$U'" >/dev/null
attempt "$EMAIL" "falsch-alt"
assert_eq "nine old ones and a new one: a count of one, no lock" \
  "$(sql "select \"failedLoginCount\" || ' ' || (\"loginLockedUntil\" is null) from \"User\" where id='$U'")" "1 true"

note "=== 5. a new password through the e-mail link ends a lock ==="
assert_eq "resetPassword clears the count and the lock" \
  "$(grep -A12 'Invalidate any other active reset tokens' "$SCRIPT_DIR/../src/modules/auth/auth.service.ts" | grep -cE 'failedLoginCount: 0|loginLockedUntil: null')" "2"
summary
