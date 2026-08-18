#!/usr/bin/env bash
# e2e 143: Tier 119 — Cron health monitoring.
#
# Verifies the /admin/cron-health endpoint surfaces
# last-run info for the 8 known crons (Tier 120 added
# daily-auto-backup). We can't wait for the daily
# schedules to fire (vat-reverify doesn't run until
# 02:00, etc.), so this test:
#
#   1. Wipes any prior CronHealth rows
#   2. Calls the endpoint — every cron should be
#      "grey" (never run) on a fresh DB
#   3. Triggers the webhook-retry-worker via a manual
#      "fake" row insert (its 1-minute cron is too slow
#      for an e2e) by inserting a CronHealth row
#      directly and verifying the endpoint surfaces
#      the green status
#   4. Verifies the manual POST /admin/cron-health/clean
#      endpoint removes old rows
#
# Tier 119 e2e — 4 sections, 6+ assertions.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)
PREFIX="T119-$TS"

note "=== Test prefix: $PREFIX ==="

# ───── 0. Wipe prior CronHealth rows + verify schema ─────
note "=== 0. Cleanup + schema check ==="
# Wipe ALL CronHealth rows so the "all 7 grey" assertion
# in step 1 is deterministic. The production webhook-
# retry-worker has already recorded ticks in the dev
# DB, so we clean them out here (the cron will re-
# record a tick within a minute).
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "CronHealth";
SQL
pass "wiped all CronHealth rows"

# Verify the table exists (schema push must have run)
TABLE_EXISTS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'CronHealth';" 2>&1 | tr -d ' ' | head -1)
test "$TABLE_EXISTS" = "1" && pass "CronHealth table exists" \
  || fail "CronHealth table missing — did prisma db push run?"

# ───── 1. Fresh endpoint → all "grey" ─────
note "=== 1. Fresh state: all 8 crons grey ==="
api_get "/api/v1/admin/cron-health"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
test "$COUNT" = "8" && pass "endpoint returns 8 crons" \
  || fail "expected 8 crons, got $COUNT"
GREY_COUNT=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(sum(1 for c in d if c.get('health') == 'grey'))
")
test "$GREY_COUNT" = "8" && pass "all 8 crons are grey (fresh DB)" \
  || fail "expected 8 grey, got $GREY_COUNT"

# Verify the schedule info is present
SCHEDULES=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(','.join(c.get('schedule','') for c in d))
")
note "schedules: $SCHEDULES"
echo "$SCHEDULES" | grep -q "0 9 \* \* \*" && pass "reminder-auto-send at 09:00 daily" \
  || fail "reminder-auto-send schedule missing"
echo "$SCHEDULES" | grep -q "0 2 \* \* \*" && pass "vat-reverify + exchange-rate at 02:00" \
  || fail "02:00 schedule missing"

# ───── 2. Insert a fake success tick for webhook-retry-worker ─────
note "=== 2. fake success tick → green ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "CronHealth" (id, name, status, "startedAt", "durationMs", summary)
VALUES (gen_random_uuid()::text, 'webhook-retry-worker', 'success', now() - interval '30 seconds', 42, '5 succeeded, 0 failed, 0 exhausted');
SQL
pass "inserted fake success tick"

api_get "/api/v1/admin/cron-health"
# Find the webhook-retry-worker row
WH_STATUS=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d:
  if c['name'] == 'webhook-retry-worker':
    print(c.get('status',''))
    break
")
WH_HEALTH=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d:
  if c['name'] == 'webhook-retry-worker':
    print(c.get('health',''))
    break
")
test "$WH_STATUS" = "success" && pass "webhook-retry-worker: status=success" \
  || fail "webhook-retry-worker: status=$WH_STATUS (expected success)"
test "$WH_HEALTH" = "green" && pass "webhook-retry-worker: health=green" \
  || fail "webhook-retry-worker: health=$WH_HEALTH (expected green)"

# ───── 3. Insert a fake failed tick → red ─────
note "=== 3. fake failed tick → red ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "CronHealth" (id, name, status, "startedAt", "durationMs", "errorMessage")
VALUES (gen_random_uuid()::text, 'exchange-rate-refresh', 'failed', now() - interval '5 minutes', 3000, 'ECONNREFUSED to ecb.europa.eu');
SQL
pass "inserted fake failed tick"

api_get "/api/v1/admin/cron-health"
ER_HEALTH=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d:
  if c['name'] == 'exchange-rate-refresh':
    print(c.get('health',''))
    break
")
ER_ERROR=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d:
  if c['name'] == 'exchange-rate-refresh':
    print(c.get('lastError',''))
    break
")
test "$ER_HEALTH" = "red" && pass "exchange-rate-refresh: health=red" \
  || fail "exchange-rate-refresh: health=$ER_HEALTH (expected red)"
echo "$ER_ERROR" | grep -q "ECONNREFUSED" && pass "lastError captures failure detail" \
  || fail "lastError missing ECONNREFUSED (got: $ER_ERROR)"

# ───── 4. Insert an old success tick (>2× interval) → amber ─────
note "=== 4. stale success (>2× interval) → amber ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "CronHealth" (id, name, status, "startedAt", "durationMs")
VALUES (gen_random_uuid()::text, 'reminder-auto-send', 'success', now() - interval '3 days', 5000);
SQL
pass "inserted stale success tick (3 days ago, interval=1d)"

api_get "/api/v1/admin/cron-health"
REM_HEALTH=$(echo "$BODY" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for c in d:
  if c['name'] == 'reminder-auto-send':
    print(c.get('health',''))
    break
")
test "$REM_HEALTH" = "amber" && pass "reminder-auto-send (stale): health=amber" \
  || fail "reminder-auto-send: health=$REM_HEALTH (expected amber — 3d > 2×1d)"

# ───── 5. Clean endpoint ─────
note "=== 5. POST /admin/cron-health/clean ==="
# Insert a row from 10 days ago (older than the 7-day retention)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "CronHealth" (id, name, status, "startedAt")
VALUES (gen_random_uuid()::text, 'old-cron-tick', 'success', now() - interval '10 days');
SQL
OLD_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"CronHealth\" WHERE name = 'old-cron-tick';" 2>&1 | tr -d ' ' | head -1)
test "$OLD_COUNT" = "1" && pass "old row exists (10d ago)" \
  || fail "old row missing (count=$OLD_COUNT)"

# Trigger clean
api_get "/api/v1/admin/cron-health/clean" -X POST 2>&1 || true
# Actually need a POST
CLEAN_RESP=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/admin/cron-health/clean")
note "clean response: $CLEAN_RESP"

OLD_AFTER=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"CronHealth\" WHERE name = 'old-cron-tick';" 2>&1 | tr -d ' ' | head -1)
test "$OLD_AFTER" = "0" && pass "clean removed the 10d-old row" \
  || fail "clean did not remove (count=$OLD_AFTER)"

# ───── 6. Cleanup ─────
note "=== 6. Cleanup ==="
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "CronHealth" WHERE name IN ('webhook-retry-worker', 'exchange-rate-refresh', 'reminder-auto-send', 'old-cron-tick');
SQL
pass "cleaned up test fixtures"

summary "Tier 119 — Cron health monitoring (admin/cron-health endpoint)"
