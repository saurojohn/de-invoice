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

# Tier 361: per-spec timeout. None of the specs has one, there is no
# timeout(1) on macOS, and CI's job limit is GitHub's 6-hour default, so a
# single hung curl or docker exec would stall the whole suite. The spec runs
# in the background (stdin from /dev/null) with a watchdog that kills it —
# and its direct children — after SPEC_TIMEOUT seconds; it then counts as
# failed. The slowest spec takes well under a minute.
SPEC_TIMEOUT="${SPEC_TIMEOUT:-600}"
run_spec() {
  bash "$1" < /dev/null &
  local pid=$!
  # stderr of the watchdog goes to /dev/null: killing its sleep at the end of
  # every spec otherwise prints a "Terminated: 15 sleep" job notice.
  (
    sleep "$SPEC_TIMEOUT"
    if kill -0 "$pid" 2>/dev/null; then
      echo "  TIMEOUT: $1 still running after ${SPEC_TIMEOUT}s, killing it"
      pkill -TERM -P "$pid"
      kill -TERM "$pid"
    fi
  ) 2>/dev/null &
  local watchdog=$!
  wait "$pid"
  local rc=$?
  pkill -P "$watchdog" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
}

# Tier 361: quarantine. Turning on the 70 three-digit specs, 17 failed on a
# CI-equivalent stack (backend/scripts/local-ci-stack.sh). They are listed
# here with the symptom seen, NOT a diagnosed cause, and are fixed and
# removed one by one. A quarantined spec still runs and is reported below,
# but does not fail the suite; if it passes, the summary says to remove it.
# Never add a spec here to get a red build green without writing down why.
QUARANTINE=(
  # 17 were quarantined when Tier 361 turned the three-digit specs on; 15 were
  # fixed in the same tier, 142 in Tier 362, 124 in Tier 363 (HANDOFF lists what
  # each needed). Empty now — only add a spec with its symptom written down.
)
is_quarantined() {
  local q
  for q in ${QUARANTINE[@]+"${QUARANTINE[@]}"}; do [[ "$q" == "$1" ]] && return 0; done
  return 1
}
Q_FAILED=()
Q_PASSED=()

cd "$SCRIPT_DIR"
PASS=0
FAIL=0
FAILED_TESTS=()
RUN_IN_SEG=0
SEG_NUM=1
# Tier 361: three-digit specs too. This loop used to be `[0-9][0-9]-*.sh`
# — two digits then a hyphen — so the 70 specs numbered 100-169 never ran,
# here or in CI, and "99/99" meant the two-digit specs only. Globs expand in
# sorted order, so two-digit specs still run first, then 100-169.
for t in [0-9][0-9]-*.sh [0-9][0-9][0-9]-*.sh; do
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
  if run_spec "$t"; then
    if is_quarantined "$t"; then Q_PASSED+=("$t"); else PASS=$((PASS+1)); fi
  else
    if is_quarantined "$t"; then
      Q_FAILED+=("$t")
    else
      FAIL=$((FAIL+1))
      FAILED_TESTS+=("$t")
    fi
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
echo "  Quarantined (not counted above, see QUARANTINE in run-all.sh): ${#Q_FAILED[@]} still failing, ${#Q_PASSED[@]} now passing"
if [[ ${#Q_PASSED[@]} -gt 0 ]]; then
  echo "  These quarantined specs PASSED — remove them from QUARANTINE:"
  for t in "${Q_PASSED[@]}"; do echo "    + $t"; done
fi
echo "════════════════════════════════════════════════════════"
exit $FAIL
