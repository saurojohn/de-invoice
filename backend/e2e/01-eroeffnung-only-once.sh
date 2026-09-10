#!/bin/bash
# Test 01: Only one eroeffnung (Anfangsbestand) is allowed per cash book.
# §146 AO: the Kassenbuch is a single sequential journal, and the
# opening balance is set exactly once.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: only one eroeffnung per cash book ==="

# First eroeffnung should succeed
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-01\",
  \"type\":\"eroeffnung\",
  \"description\":\"Anfangsbestand\",
  \"amount\":500
}"
assert_status "201" "First eroeffnung (500€)"

# Second eroeffnung should be rejected
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-15\",
  \"type\":\"eroeffnung\",
  \"description\":\"Zweiter Anfangsbestand\",
  \"amount\":999
}"
assert_status "400" "Second eroeffnung rejected"

# Verify the error message mentions the duplicate
if echo "$BODY" | grep -qi "bereits ein Eröffnungs-Eintrag"; then
  pass "Error message mentions existing eroeffnung"
else
  fail "Error message should mention 'Eröffnungs-Eintrag': $BODY"
fi

# Verify only 1 row in DB
COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"CashBookEntry\" WHERE \"companyId\" = '$COMPANY_ID' AND type = 'eroeffnung';" 2>/dev/null | tr -d ' ')
assert_eq "eroeffnung rows in DB" "$COUNT" "1"

cleanup_cashbook
summary
