#!/bin/bash
# Tier 368 — the auth audit rows exist at all, and are signed
#
# Two defects, both invisible until this spec existed. NOTHING in the suite
# had ever asserted on an auth audit row (`login_failed`, `login_success`,
# `password_reset_*`), which is exactly why both survived so long:
#
#   1. A failed login with an e-mail that does NOT exist wrote
#      `companyId: 'unknown'` and `userId: 'unknown'`. Both columns are
#      foreign keys (AuditLog_companyId_fkey -> Company, AuditLog_userId_fkey
#      -> User), so every insert violated them, and the call site swallowed
#      the error in an empty `catch { /* ignore */ }` — not even a log line.
#      Measured on a throwaway stack before the fix: an unknown-e-mail login
#      returned HTTP 400 and produced ZERO AuditLog rows, while a real user
#      with a wrong password (real ids) wrote its row fine. The un-audited
#      case was precisely the interesting one: user enumeration and
#      credential stuffing.
#   2. All nine of these call sites wrote via `prisma.auditLog.create`, which
#      bypasses the audit extension — so the rows carried no hash and sat
#      outside the GoBD chain. They now go through `audit.service.writeActivity`,
#      which signs them and chains them under the per-company advisory lock.
#
# NOTE on the failed-login counter: auth.controller keeps its own per-IP
# counter (FAILED_LOGIN_MAX = 5, 15 min lockout). It is NOT governed by
# THROTTLE_DISABLED. This spec therefore makes exactly TWO failed attempts and
# finishes with a SUCCESSFUL login, whose handler calls attempts.delete(ip) —
# leaving the counter clean for every spec that runs after it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

BOGUS_EMAIL="tier368-no-such-user@example.invalid"

q() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '
}

note "=== 1. a failed login for an e-mail that does not exist is audited ==="
# Before Tier 368 this produced no row at all (FK violation, silently caught).
BEFORE=$(q "SELECT count(*) FROM \"AuditLog\" WHERE action='login_failed';")
STATUS_BOGUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$BOGUS_EMAIL\",\"password\":\"wrong-on-purpose\"}")
assert_eq "login with an unknown e-mail is rejected" "$STATUS_BOGUS" "400"
AFTER=$(q "SELECT count(*) FROM \"AuditLog\" WHERE action='login_failed';")
test "${AFTER:-0}" -gt "${BEFORE:-0}" \
  && pass "login_failed row written ($BEFORE -> $AFTER)" \
  || fail "no login_failed row was written ($BEFORE -> $AFTER) — the FK-violation bug is back"

# The row must name the attempted address, and carry NULL ids rather than the
# literal 'unknown' that used to break the foreign keys.
assert_eq "the row records the attempted e-mail" \
  "$(q "SELECT \"entityId\" FROM \"AuditLog\" WHERE action='login_failed' ORDER BY seq DESC LIMIT 1;")" \
  "$BOGUS_EMAIL"
assert_eq "unknown-user row stores NULL ids, not the string 'unknown'" \
  "$(q "SELECT (\"companyId\" IS NULL AND \"userId\" IS NULL) FROM \"AuditLog\" WHERE action='login_failed' ORDER BY seq DESC LIMIT 1;")" \
  "t"
assert_eq "the row is signed (SHA-256-V2)" \
  "$(q "SELECT COALESCE(\"hashAlgorithm\",'(unsigned)') FROM \"AuditLog\" WHERE action='login_failed' ORDER BY seq DESC LIMIT 1;")" \
  "SHA-256-V2"

note "=== 2. a failed login for a REAL user is audited and signed ==="
STATUS_WRONGPW=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"definitely-wrong-tier368\"}")
assert_eq "login with a wrong password is rejected" "$STATUS_WRONGPW" "400"
assert_eq "the real-user failure carries the real company + user id" \
  "$(q "SELECT (\"companyId\" IS NOT NULL AND \"userId\" IS NOT NULL) FROM \"AuditLog\" WHERE action='login_failed' ORDER BY seq DESC LIMIT 1;")" \
  "t"
assert_eq "it is signed too" \
  "$(q "SELECT COALESCE(\"hashAlgorithm\",'(unsigned)') FROM \"AuditLog\" WHERE action='login_failed' ORDER BY seq DESC LIMIT 1;")" \
  "SHA-256-V2"

note "=== 3. a successful login is audited and signed (and clears the counter) ==="
# Two failures precede this; the success handler calls attempts.delete(ip), so
# the per-IP counter is back to zero for whatever runs next.
STATUS_OK=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
assert_eq "the real credentials still log in" "$STATUS_OK" "200"
assert_eq "login_success is signed" \
  "$(q "SELECT COALESCE(\"hashAlgorithm\",'(unsigned)') FROM \"AuditLog\" WHERE action='login_success' ORDER BY seq DESC LIMIT 1;")" \
  "SHA-256-V2"

note "=== 4. none of it broke the hash chain ==="
# The point of routing these through writeActivity: they are chained, not
# merely written. An unsigned row cannot break the chain (verifyChain skips
# it) — a badly chained signed row can.
api_get "/api/v1/audit-logs/verify?companyId=$COMPANY_ID"
assert_status 200 "GET /audit-logs/verify"
CHAIN_REASON=$(echo "$BODY" | python3 -c "import json,sys; b=json.load(sys.stdin).get('brokenAt') or {}; print('%s %s' % (b.get('reason',''), b.get('id','')))" 2>/dev/null)
assert_eq "chain still ok (brokenAt: ${CHAIN_REASON:-none})" "$(json_field "$BODY" ok)" "True"

# Deliberately NO cleanup: these are legitimate audit rows, and deleting a
# signed row would break the previousHash pointer of everything after it.

summary
