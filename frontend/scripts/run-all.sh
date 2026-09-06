#!/bin/bash
# scripts/run-all.sh — Tier 313: run the full Playwright
# suite with segment checkpoints to avoid the dev PG
# crash that wiped out the 4-day-uptime container in
# Tier 310.
#
# Why this script:
#   The backend's e2e/run-all.sh (Tier 312) already
#   has segment checkpoints. The frontend Playwright
#   suite is the OTHER side of the same problem —
#   888 specs in a single Playwright run with
#   retries=2 + the dev backend restarts on VIES
#   (Tier 309) + admin/AfA cold-compile pages that
#   take 30-60s on first hit = 4+ hours of state
#   churn on the shared dev PG.
#
# What this does:
#   1. Splits the 888-spec suite into segments of
#      SEGMENT_SIZE=50 specs each.
#   2. Between segments: 15s sleep + /health/deep
#      200 ping to confirm the backend survived.
#   3. If the ping fails, the script aborts with
#      a clear 'fix-dev-pg.sh' message rather than
#      continuing into a corrupt-DB cascade.
#   4. The full suite becomes 18 segments × 50
#      specs, each with a /health/deep checkpoint.
#
# Usage:
#   SEGMENT_SIZE=50 SEGMENT_SLEEP=15 ./scripts/run-all.sh
#   # Or just:
#   ./scripts/run-all.sh  # uses defaults
#
# Prereq: backend at localhost:3001 + frontend at
# localhost:3100 + PG container up.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SEGMENT_SIZE="${SEGMENT_SIZE:-50}"
SEGMENT_SLEEP="${SEGMENT_SLEEP:-15}"

# Pre-flight: backend + db reachable
if ! curl -sS -o /dev/null -w "%{http_code}" http://localhost:3001/api/v1/health/deep \
     --max-time 2 2>/dev/null | grep -q "200"; then
  echo "FATAL: backend not reachable on localhost:3001 (or unhealthy)" >&2
  exit 1
fi
if ! docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "SELECT 1" >/dev/null 2>&1; then
  echo "FATAL: Postgres container 'de-invoice-postgres' not reachable" >&2
  echo "  Run 'bash scripts/fix-dev-pg.sh' to recover the dev DB." >&2
  exit 1
fi

cd "$REPO_ROOT"
SEG_NUM=1
RUN_IN_SEG=0
ALL_SPECS=$(find frontend/e2e -name "*.spec.ts" | sort)
TOTAL=$(echo "$ALL_SPECS" | wc -l | tr -d ' ')

echo "Running $TOTAL Playwright specs in segments of $SEGMENT_SIZE"
echo "Segment checkpoint: ${SEGMENT_SLEEP}s sleep + /health/deep ping"
echo ""

# Use xargs to run tests in segments. Each segment is
# SEGMENT_SIZE specs, then we pause and check health.
HEAD=0
TAIL=$SEGMENT_SIZE
while [ $HEAD -lt $TOTAL ]; do
  SEG_SPECS=$(echo "$ALL_SPECS" | sed -n "$((HEAD + 1)),${TAIL}p")
  SEG_COUNT=$(echo "$SEG_SPECS" | grep -c .)

  if [ -z "$SEG_SPECS" ]; then
    break
  fi

  echo "────────────────────────────────────────────────────────"
  echo "Segment $SEG_NUM: specs $((HEAD + 1))-$((HEAD + SEG_COUNT)) (of $TOTAL)"
  echo "────────────────────────────────────────────────────────"
  if ! echo "$SEG_SPECS" | xargs npx playwright test --reporter=list; then
    echo "Segment $SEG_NUM had failures — continuing to checkpoint" >&2
  fi

  HEAD=$TAIL
  TAIL=$((TAIL + SEGMENT_SIZE))
  RUN_IN_SEG=$SEG_COUNT
  SEG_NUM=$((SEG_NUM + 1))

  # Checkpoint
  if [ $HEAD -lt $TOTAL ]; then
    echo ""
    echo "Segment $((SEG_NUM - 1)) done ($RUN_IN_SEG specs). Sleeping ${SEGMENT_SLEEP}s..."
    sleep $SEGMENT_SLEEP
    DEEP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 \
      http://localhost:3001/api/v1/health/deep 2>/dev/null)
    if [ "$DEEP" != "200" ]; then
      echo "FATAL: backend unhealthy at segment boundary (status: $DEEP)" >&2
      echo "  Aborting to avoid corrupting the dev PG." >&2
      echo "  Run 'bash scripts/fix-dev-pg.sh' to recover." >&2
      exit 1
    fi
    echo "Backend healthy, continuing."
    echo ""
  fi
done

echo ""
echo "All segments complete."
