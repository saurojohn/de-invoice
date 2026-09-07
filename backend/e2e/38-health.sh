#!/bin/bash
# Tier 11: /health and /health/deep endpoints.
#
# Coverage:
#   1. /health returns 200 with status='ok',
#      version, uptimeSec, timestamp
#   2. /health does NOT require auth (no
#      x-user-id / x-company-id headers)
#   3. /health/deep returns 200 with all
#      checks (db, storage) status='ok'
#   4. /health/deep DB check returns a
#      latency number (>= 0ms)
#   5. /health/deep storage check returns
#      the storage path
#   6. /health does NOT expose version
#      query parameters (it must be a
#      constant string, not user-controllable)
#   7. /health is idempotent (calling it
#      3 times in a row returns the same
#      shape; uptimeSec is monotonically
#      non-decreasing)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

echo "=== Test: Tier 11 /health endpoints ==="

# ===== 1. /health returns 200 with the right shape =====
RAW=$(curl -sS http://localhost:3001/api/v1/health)
STATUS=$(echo "$RAW" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "1. /health status=ok" "$STATUS" "ok"

# Required fields present
HAS_VERSION=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'version' in d else 'no')")
assert_eq "1b. /health has version field" "$HAS_VERSION" "yes"

HAS_UPTIME=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'uptimeSec' in d and isinstance(d['uptimeSec'], int) else 'no')")
assert_eq "1c. /health uptimeSec is an integer" "$HAS_UPTIME" "yes"

HAS_TS=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'timestamp' in d else 'no')")
assert_eq "1d. /health has timestamp" "$HAS_TS" "yes"

# ===== 2. /health does NOT require auth =====
# We don't pass any x-user-id / x-company-id
# headers, so this would 401 if the route was
# behind the auth guard. The fact that we got
# 200 in step 1 is the assertion, but we also
# verify the body is JSON not the standard
# Nest 401 envelope.
HAS_401=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('statusCode') == 401 else 'no')")
assert_eq "2. /health is unauthenticated (no 401)" "$HAS_401" "no"

# ===== 3. /health/deep returns 200 with checks =====
RAW=$(curl -sS http://localhost:3001/api/v1/health/deep)
STATUS=$(echo "$RAW" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "3. /health/deep status=ok" "$STATUS" "ok"

# Both db and storage are present and ok
DB_OK=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['checks']['db']['status'])")
assert_eq "3b. db check status=ok" "$DB_OK" "ok"

STORAGE_OK=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['checks']['storage']['status'])")
assert_eq "3c. storage check status=ok" "$STORAGE_OK" "ok"

# ===== 4. DB check returns a latency number =====
DB_DETAIL=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['checks']['db']['detail'])")
note "DB latency: $DB_DETAIL"
HAS_MS=$(echo "$DB_DETAIL" | grep -c "ms" || true)
[[ "$HAS_MS" -ge 1 ]] && pass "4. db detail includes latency in ms" || fail "4. db detail missing ms unit (got: $DB_DETAIL)"

# ===== 5. Storage check returns the storage path =====
# Tier 332: relax the assertion. The previous
# substring check (`*invoice-system*`) tied the
# spec to the developer's local path
# (/Users/shledergmbh/data/invoice-system). On
# CI the storage base is /tmp/de-invoice-storage,
# which has no `invoice-system` substring, so the
# check failed every time despite storage being
# perfectly healthy. Switch to a directory-
# existence check — the deeper contract is
# "the path is a usable directory", not
# "the path contains a specific brand string".
STORAGE_PATH=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['checks']['storage']['detail'])")
if [[ -n "$STORAGE_PATH" && -d "$STORAGE_PATH" ]]; then
  pass "5. storage path is a directory (got: $STORAGE_PATH)"
else
  fail "5. storage path missing or not a directory (got: $STORAGE_PATH)"
fi

# ===== 6. /health does NOT accept user-controllable version =====
# We hit the endpoint and confirm the version
# field is NOT something a request parameter
# can change. The only way to test this is to
# see the version is stable across two calls.
# (A more aggressive test would be to fuzz
# ?version=... and confirm the response
# stays the same, but the value comes from
# process.env.npm_package_version so it's
# compile-time — can't be request-controlled.)
V1=$(curl -sS "http://localhost:3001/api/v1/health?version=hax0r" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
V2=$(curl -sS "http://localhost:3001/api/v1/health" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
assert_eq "6. /health version is not request-controllable" "$V1" "$V2"

# ===== 7. uptimeSec is monotonically non-decreasing =====
U1=$(curl -sS http://localhost:3001/api/v1/health | python3 -c "import json,sys; print(json.load(sys.stdin)['uptimeSec'])")
sleep 2
U2=$(curl -sS http://localhost:3001/api/v1/health | python3 -c "import json,sys; print(json.load(sys.stdin)['uptimeSec'])")
if [[ "$U2" -ge "$U1" ]]; then
  pass "7. uptimeSec non-decreasing ($U1 -> $U2)"
else
  fail "7. uptimeSec went backwards ($U1 -> $U2)"
fi

# ===== 8. /health/deep also does NOT require auth =====
# If the endpoint was behind the guard, the
# body would have statusCode=401. We already
# tested this for /health, so we just confirm
# the same for /health/deep.
HAS_401_DEEP=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('statusCode') == 401 else 'no')")
assert_eq "8. /health/deep is unauthenticated (no 401)" "$HAS_401_DEEP" "no"

# ===== 9. /health/deep timestamp is ISO 8601 =====
TS=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['timestamp'])")
# ISO 8601 with Z suffix matches the regex
ISO_OK=$(echo "$TS" | grep -cE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+Z$" || true)
[[ "$ISO_OK" -ge 1 ]] && pass "9. timestamp is ISO 8601 (got: $TS)" || fail "9. timestamp not ISO 8601 (got: $TS)"

# ===== 10. Concurrent requests don't crash the endpoint =====
# The /health/deep endpoint pings Postgres
# on every call. A quick burst should be
# fully parallel-safe (Prisma's connection
# pool handles it).
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/v1/health/deep &
done
wait
ALL_OK=$(curl -sS http://localhost:3001/api/v1/health/deep | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if d['status'] == 'ok' else 'no')")
assert_eq "10. /health/deep still 200 after burst" "$ALL_OK" "yes"

summary