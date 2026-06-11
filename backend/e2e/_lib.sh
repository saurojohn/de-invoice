#!/bin/bash
# Common helpers for Kassenbuch GoBD e2e tests.
# Each test file `source`s this, then runs the assertions.
#
# Tests against the live backend at http://localhost:3001.
# Run with: `./e2e/run-all.sh` (starts backend if needed)
# Or individually: `bash e2e/01-eroeffnung-only-once.sh`

set -uo pipefail

# ---- Config ----
API="${API:-http://localhost:3001}"
EMAIL="${TEST_EMAIL:-info@shleder.de}"
PASSWORD="${TEST_PASSWORD:-Test1234!}"

# ---- Colour helpers (skip if NO_COLOR is set or not a tty) ----
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; NC=''
fi

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILS=$((FAILS+1)); }
note() { echo -e "${YELLOW}…${NC} $1"; }
FAILS=0

# ---- Auth ----
# Cache the auth headers in a temp file so multiple tests
# run in sequence don't each burn a login slot on the
# Throttler (the default limit is ~10/min and 6 tests
# in 30 seconds hits it). The first test to call login()
# does the real POST; subsequent tests pick up the cached
# values from the env vars.
AUTH_CACHE="/tmp/cashbook-e2e-auth.env"
login() {
  if [[ -f "$AUTH_CACHE" ]]; then
    source "$AUTH_CACHE"
    return
  fi
  local resp
  resp=$(curl -sS -X POST "$API/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
  USER_ID=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  COMPANY_ID=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin).get('companyId',''))" 2>/dev/null)
  if [[ -z "$USER_ID" || -z "$COMPANY_ID" ]]; then
    echo "FATAL: login failed: $resp" >&2
    exit 2
  fi
  # Cache for subsequent tests in the same run
  cat > "$AUTH_CACHE" <<EOF
USER_ID=$USER_ID
COMPANY_ID=$COMPANY_ID
EOF
}

# ---- DB cleanup (delete all cashbook rows for the test company) ----
cleanup_cashbook() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"CashBookEntry\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"CashBookDailyClose\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1
}

# ---- API helpers (all return the HTTP status code in $STATUS) ----
api_post() {
  local path="$1" body="$2"
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API$path" \
    -H "Content-Type: application/json" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" \
    -d "$body")
  STATUS=$(echo "$resp" | tail -n1)
  BODY=$(echo "$resp" | sed '$d')
}

api_put() {
  local path="$1" body="$2"
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X PUT "$API$path" \
    -H "Content-Type: application/json" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID" \
    -d "$body")
  STATUS=$(echo "$resp" | tail -n1)
  BODY=$(echo "$resp" | sed '$d')
}

api_get() {
  local path="$1"
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X GET "$API$path" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID")
  STATUS=$(echo "$resp" | tail -n1)
  BODY=$(echo "$resp" | sed '$d')
}

api_delete() {
  local path="$1"
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X DELETE "$API$path" \
    -H "x-user-id: $USER_ID" \
    -H "x-company-id: $COMPANY_ID")
  STATUS=$(echo "$resp" | tail -n1)
  BODY=$(echo "$resp" | sed '$d')
}

# ---- Convenience: expect HTTP status, return BODY ----
assert_status() {
  local expected="$1" what="$2"
  if [[ "$STATUS" == "$expected" ]]; then
    pass "$what (HTTP $STATUS)"
  else
    fail "$what (expected $expected, got $STATUS) — body: $BODY"
  fi
}

# Extract a JSON field via python. Supports dotted paths
# (e.g. "config.bank" → json['config']['bank']) because
# plain bracket access only handles a single key.
#
# Usage: json_field "$BODY" config.bank
# (keeps the old $body $path call signature for callers)
json_field() {
  local body="$1" path="$2"
  python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for k in '$path'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: break
print(d if d is not None else '')
" <<< "$body" 2>/dev/null
}

# file_contains — like grep -q but works on ISO-8859 / Windows-1252
# files (DATEV export uses Latin-1, and a UTF-8 default locale
# would have grep silently skip the file as 'binary'). We
# match on a raw byte string, no locale awareness needed.
file_contains() {
  local pattern="$1" file="$2"
  LC_ALL=C grep -q -- "$pattern" "$file" 2>/dev/null
}

# Assert that a JSON value (passed as $1) equals $2 within rounding
assert_eq() {
  local what="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$what = $actual"
  else
    fail "$what expected=$expected actual=$actual"
  fi
}

assert_close() {
  local what="$1" actual="$2" expected="$3" tol="${4:-0.01}"
  if python3 -c "import sys; sys.exit(0 if abs(float('$actual')-float('$expected'))<=$tol else 1)" 2>/dev/null; then
    pass "$what = $actual (≈$expected)"
  else
    fail "$what = $actual but expected ≈$expected"
  fi
}

summary() {
  if [[ $FAILS -eq 0 ]]; then
    echo -e "\n${GREEN}ALL PASSED${NC}"
    return 0
  else
    echo -e "\n${RED}$FAILS assertion(s) FAILED${NC}"
    return 1
  fi
}
