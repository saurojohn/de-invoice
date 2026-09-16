#!/bin/bash
# Tier 403 — a password reset ends the sessions that existed before it
#
# Measured before the fix, on the stack:
#   register → session minted   → GET /customers  200
#   forgot-password + reset     → {"ok":true, "Sie können sich jetzt anmelden"}
#   the SAME session afterwards → 200
# Resetting the password is what someone does when they believe their account
# is in the wrong hands. The intruder's session survived it and, with 30-day
# sliding expiry, kept working for a month while the owner believed they had
# locked them out. (Deactivating the user and revoking the company grant were
# already enforced per request by HeaderAuthGuard — measured, both 401 — so the
# reset was the one path that did not evict anyone.)
#
# Also: nothing ever deleted a session row, in either session table. Tier 403
# adds the nightly `session-cleanup` cron; the rows are kept for
# SESSION_RETENTION_DAYS (90) because a dead row still answers "who was signed
# in, from where, when".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-192-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

REG=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier403-first1\",\"companyName\":\"$TAG GmbH\"}")
read -r U C < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
T1=$(json_field "$REG" sessionToken)
[[ -n "${U:-}" && ${#T1} -eq 64 ]] && pass "fixture: a user with a live session" || { fail "fixture: $REG"; summary; exit 1; }

# A second session, so the test shows that ALL of them go, not just one.
T2=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier403-first1\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))" 2>/dev/null)
ALIVE() { curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/customers?companyId=$C" \
  -H "Cookie: de_session=$1" -H "x-company-id: $C"; }
assert_eq "…and a second one from another sign-in" "$(ALIVE "$T2")" "200"

note "=== 1. the reset evicts every session ==="
curl -sS -o /dev/null -X POST "$API/api/v1/auth/forgot-password" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\"}"
# In dev/CI there is no SMTP, so the link is logged — the same way e2e 18 reads
# it. The token is bcrypt-hashed in the column, so the log is the only source.
RESET_TOKEN=$(grep -o "reset-password?token=[A-Za-z0-9_-]*" /tmp/backend.log | tail -1 | cut -d= -f2)
[[ -n "$RESET_TOKEN" ]] && pass "fixture: a reset token" || { fail "no reset link in /tmp/backend.log"; summary; exit 1; }
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/auth/reset-password" -H "Content-Type: application/json" \
  -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"Tier403-second2\"}")
STATUS=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_status 200 "the reset succeeds"

assert_eq "the session from before the reset is dead (was 200)" "$(ALIVE "$T1")" "401"
assert_eq "…and so is the second one" "$(ALIVE "$T2")" "401"
assert_eq "…both rows carry revokedAt" \
  "$(sql "SELECT count(*) FROM \"UserSession\" WHERE \"userId\" = '$U' AND \"revokedAt\" IS NOT NULL;")" "2"
assert_eq "…and none is left live" \
  "$(sql "SELECT count(*) FROM \"UserSession\" WHERE \"userId\" = '$U' AND \"revokedAt\" IS NULL;")" "0"
# The trail should show the lock-out happened, not just that a password changed.
assert_eq "the audit row records how many were ended" \
  "$(sql "SELECT \"newData\"->>'endedSessions' FROM \"AuditLog\" WHERE action = 'password_reset_success' AND \"entityId\" = '$U' ORDER BY seq DESC LIMIT 1;")" "2"

note "=== 2. the owner can get back in, with the new password only ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier403-first1\"}")
assert_status 400 "the old password no longer works"
NEW=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier403-second2\"}")
T3=$(json_field "$NEW" sessionToken)
assert_eq "the new password mints a fresh session" "$(ALIVE "$T3")" "200"

note "=== 3. dead rows are cleaned up; live ones are not ==="
# A row that expired long before the retention window.
sql "INSERT INTO \"UserSession\" (id, \"userId\", token, \"expiresAt\", \"lastSeenAt\", \"createdAt\")
     VALUES ('$TAG-stale', '$U', '$TAG-stale-token', now() - interval '200 days', now() - interval '200 days', now() - interval '200 days');" >/dev/null
# And one that is dead but still inside it — evidence an operator may need.
sql "INSERT INTO \"UserSession\" (id, \"userId\", token, \"expiresAt\", \"lastSeenAt\", \"createdAt\")
     VALUES ('$TAG-recent', '$U', '$TAG-recent-token', now() - interval '5 days', now() - interval '5 days', now() - interval '35 days');" >/dev/null
assert_eq "fixture: one long-expired row, one recently expired" \
  "$(sql "SELECT count(*) FROM \"UserSession\" WHERE id IN ('$TAG-stale','$TAG-recent');")" "2"
api_post "/api/v1/admin/cron-health/session-cleanup/run" "{}"
assert_status 201 "the cleanup cron can be fired"
# The trigger is fire-and-forget; poll rather than sleep a fixed time.
for _ in $(seq 1 20); do
  [[ "$(sql "SELECT count(*) FROM \"UserSession\" WHERE id = '$TAG-stale';")" == "0" ]] && break
  sleep 1
done
assert_eq "the long-expired row is gone" "$(sql "SELECT count(*) FROM \"UserSession\" WHERE id = '$TAG-stale';")" "0"
assert_eq "…the recently expired one is kept as evidence" \
  "$(sql "SELECT count(*) FROM \"UserSession\" WHERE id = '$TAG-recent';")" "1"
assert_eq "…and the live session is untouched" "$(ALIVE "$T3")" "200"
assert_eq "the run is visible to the admin dashboard" \
  "$(sql "SELECT status FROM \"CronHealth\" WHERE name = 'session-cleanup' ORDER BY \"startedAt\" DESC LIMIT 1;")" "success"

summary; exit $?
