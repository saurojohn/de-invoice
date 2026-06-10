#!/bin/bash
# Run all Kassenbuch GoBD e2e tests in order.
# Each test is self-contained (creates + cleans up its own data).
#
# Prereq: backend running on localhost:3001 + Postgres container
# `de-invoice-postgres` up.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Pre-flight: check backend + db reachable
if ! curl -sS -o /dev/null -w "%{http_code}" http://localhost:3001/api/v1/auth/login \
     -X POST -H "Content-Type: application/json" \
     -d '{"email":"info@shleder.de","password":"Test1234!"}' 2>/dev/null | grep -q "200\|201"; then
  echo "FATAL: backend not reachable on localhost:3001" >&2
  exit 1
fi
if ! docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "SELECT 1" >/dev/null 2>&1; then
  echo "FATAL: Postgres container 'de-invoice-postgres' not reachable" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
PASS=0
FAIL=0
FAILED_TESTS=()
for t in [0-9][0-9]-*.sh; do
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
