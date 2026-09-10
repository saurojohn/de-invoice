#!/bin/bash
# Run all Kassenbuch GoBD e2e tests in order.
# Each test is self-contained (creates + cleans up its own data).
#
# Prereq: backend running on localhost:3001 + Postgres container
# `de-invoice-postgres` up.
#
# Tier 312: the 2026-09-05 full run-all crashed the
# dev PG container (Tier 310 + Tier 311 root cause
# analysis) by hitting max_connections=300 around
# spec 75-85 (the 1500-voucher seeding specs) and
# being killed mid-write. The fix: checkpoint
# reset of PG every 20 specs to keep the connection
# storm bounded. A full 99-spec run now becomes
# 5 segments × 20 specs, with a 10s sleep + a
# /health/deep ping between segments to confirm
# the backend is still alive. If the ping fails,
# the script aborts with a clear message rather
# than continuing into a corrupt-DB cascade.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEGMENT_SIZE="${SEGMENT_SIZE:-20}"
SEGMENT_SLEEP="${SEGMENT_SLEEP:-10}"

# Pre-flight: check backend + db reachable
if ! curl -sS -o /dev/null -w "%{http_code}" http://localhost:3001/api/v1/auth/login \
     -X POST -H "Content-Type: application/json" \
     -d '{"email":"info@shleder.de","password":"Test1234!"}' 2>/dev/null | grep -q "200\|201"; then
  echo "FATAL: backend not reachable on localhost:3001" >&2
  exit 1
fi
# Tier 355: honour PG_CONTAINER, same as ci-seed.sh and (since Tier 353)
# the Playwright specs. Tier 353 fixed the frontend side and missed this
# one, so a throwaway local database still could not run the backend
# suite. Default unchanged.
PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"
if ! docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "SELECT 1" >/dev/null 2>&1; then
  echo "FATAL: Postgres container '$PG_CONTAINER' not reachable" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
PASS=0
FAIL=0
FAILED_TESTS=()
RUN_IN_SEG=0
SEG_NUM=1
for t in [0-9][0-9]-*.sh; do
  # Segment checkpoint: every SEGMENT_SIZE specs, sleep +
  # health/deep ping to confirm the backend survived.
  if [[ $RUN_IN_SEG -ge $SEGMENT_SIZE ]]; then
    echo ""
    echo "────────────────────────────────────────────────────────"
    echo "  Segment $SEG_NUM checkpoint ($RUN_IN_SEG specs done)"
    echo "  Sleeping ${SEGMENT_SLEEP}s for PG connection drain..."
    sleep $SEGMENT_SLEEP
    DEEP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 1 \
      http://localhost:3001/api/v1/health/deep 2>/dev/null)
    if [ "$DEEP" != "200" ]; then
      echo "  FATAL: backend unhealthy at segment boundary (status: $DEEP)" >&2
      echo "  Aborting run-all to avoid corrupting the dev PG further." >&2
      echo "  Run 'bash scripts/fix-dev-pg.sh' (Tier 310) to recover the dev DB." >&2
      exit 1
    fi
    echo "  Backend healthy, continuing."
    RUN_IN_SEG=0
    SEG_NUM=$((SEG_NUM + 1))
  fi
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  $t"
  echo "════════════════════════════════════════════════════════"
  if bash "$t"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$t")
  fi
  RUN_IN_SEG=$((RUN_IN_SEG + 1))
done

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Total: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  echo "  Failed:"
  for t in "${FAILED_TESTS[@]}"; do echo "    - $t"; done
fi
echo "════════════════════════════════════════════════════════"
exit $FAIL
