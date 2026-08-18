#!/usr/bin/env bash
# e2e 147: Tier 124 — Cron health per-cron history.
#
# Verifies the new GET /admin/cron-health/:name/history
# endpoint:
#
#   1. Insert 3 fake rows for a fake cron name
#      (success, failed, success with different
#      durations + a "skipped" one to exercise the
#      status filter).
#   2. GET the history → returns the 4 rows
#      newest-first.
#   3. The stats object shows 2 success / 1 failed /
#      1 skipped (over the last 20 runs).
#   4. Filter by ?status=failed → returns only the
#      failed row.
#   5. Filter by ?status=success → returns 2 rows.
#   6. Bad status param → 400.
#   7. Pagination via ?skip=1&limit=1 → returns 1
#      row (the second-newest), and total is still
#      the full count.
#
# Tier 124 e2e — 7 sections, 12+ assertions.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
CRON_NAME="e2e-tier124-test-$(date +%s)"

note "=== Test: Tier 124 — Cron history ($CRON_NAME) ==="

# ───── 0. Wipe any prior rows for this test cron ─────
note "=== 0. Cleanup ==="
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"CronHealth\" WHERE name='$CRON_NAME';" >/dev/null
pass "wiped prior test rows for $CRON_NAME"

# ───── 1. Insert 4 fake rows: 2 success, 1 failed, 1 skipped ─────
note "=== 1. Insert 4 fake rows ==="
# Use single-line INSERTs (heredoc + docker exec +
# variable expansion is unreliable — bash variables
# inside a `<<SQL` heredoc piped to docker exec don't
# always expand). The Tier 117 XRechnung test also
# uses single-line INSERTs for the same reason.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"CronHealth\" (id, name, status, \"startedAt\", \"durationMs\", summary, \"errorMessage\") VALUES (gen_random_uuid()::text, '$CRON_NAME', 'success', now() - interval '1 minute', 100, 'run 1 ok', NULL);" >/dev/null
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"CronHealth\" (id, name, status, \"startedAt\", \"durationMs\", summary, \"errorMessage\") VALUES (gen_random_uuid()::text, '$CRON_NAME', 'failed', now() - interval '2 minutes', 500, NULL, 'connection refused');" >/dev/null
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"CronHealth\" (id, name, status, \"startedAt\", \"durationMs\", summary, \"errorMessage\") VALUES (gen_random_uuid()::text, '$CRON_NAME', 'success', now() - interval '3 minutes', 200, 'run 3 ok', NULL);" >/dev/null
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"CronHealth\" (id, name, status, \"startedAt\", \"durationMs\", summary, \"errorMessage\") VALUES (gen_random_uuid()::text, '$CRON_NAME', 'skipped', now() - interval '4 minutes', 0, 'no work to do', NULL);" >/dev/null
pass "inserted 4 rows (2 success / 1 failed / 1 skipped)"

# ───── 2. GET history → 4 rows newest-first ─────
note "=== 2. GET history (no filter) ==="
api_get "/api/v1/admin/cron-health/$CRON_NAME/history"
assert_status "200" "GET history"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
test "$COUNT" = "4" && pass "history returns 4 rows" \
  || fail "expected 4 rows, got $COUNT"
NEWEST_STATUS=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['items'][0]['status'])")
test "$NEWEST_STATUS" = "success" && pass "newest is the most recent success" \
  || fail "newest is $NEWEST_STATUS (expected success)"

# ───── 3. Stats — 2 success / 1 failed / 1 skipped ─────
note "=== 3. Stats over last 20 runs ==="
STATS=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)['stats']
print(f'{d[\"successCount\"]}/{d[\"failedCount\"]}/{d[\"skippedCount\"]} avg={d[\"avgDurationMs\"]} p95={d[\"p95DurationMs\"]}')")
note "stats: $STATS"
test "$STATS" = "2/1/1 avg=200 p95=500" && pass "stats match (2/1/1 avg=200 p95=500)" \
  || fail "stats wrong: $STATS (expected 2/1/1 avg=200 p95=500)"
# avg = (100+500+200+0)/4 = 200. p95 of [0,100,200,500] = 500 (largest)

# ───── 4. Filter by status=failed → 1 row ─────
note "=== 4. status=failed filter ==="
api_get "/api/v1/admin/cron-health/$CRON_NAME/history?status=failed"
assert_status "200" "GET history?status=failed"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
test "$COUNT" = "1" && pass "failed filter returns 1 row" \
  || fail "expected 1 failed, got $COUNT"
ERR=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['items'][0].get('errorMessage', ''))")
echo "$ERR" | grep -q "connection refused" && pass "failed row has the error message" \
  || fail "error message missing: $ERR"

# ───── 5. Filter by status=success → 2 rows ─────
note "=== 5. status=success filter ==="
api_get "/api/v1/admin/cron-health/$CRON_NAME/history?status=success"
assert_status "200" "GET history?status=success"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
test "$COUNT" = "2" && pass "success filter returns 2 rows" \
  || fail "expected 2 success, got $COUNT"

# ───── 6. Bad status → 400 ─────
note "=== 6. status=bogus → 400 ==="
HTTP_STATUS=$(curl -sS -o /tmp/t147-bad.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/admin/cron-health/$CRON_NAME/history?status=bogus")
test "$HTTP_STATUS" = "400" && pass "bad status returns 400" \
  || fail "bad status returned $HTTP_STATUS (expected 400)"

# ───── 7. Pagination ─────
note "=== 7. Pagination (?skip=1&limit=1) ==="
api_get "/api/v1/admin/cron-health/$CRON_NAME/history?skip=1&limit=1"
assert_status "200" "GET history?skip=1&limit=1"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
test "$COUNT" = "1" && pass "skip=1 limit=1 returns 1 row" \
  || fail "expected 1 row, got $COUNT"
TOTAL=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['total'])")
test "$TOTAL" = "4" && pass "total still 4 (pagination doesn't change total)" \
  || fail "total wrong: $TOTAL (expected 4)"

# ───── 8. Cleanup ─────
note "=== 8. Cleanup ==="
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"CronHealth\" WHERE name='$CRON_NAME';" >/dev/null
pass "cleaned up test rows"

rm -f /tmp/t147-bad.json

summary "Tier 124 — Cron health per-cron history (admin/cron-health/:name/history)"
