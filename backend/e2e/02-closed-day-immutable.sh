#!/bin/bash
# Test 02: After a Z-Bericht (Tagesabschluss), entries on that day
# are immutable. Modifications (PUT/DELETE) must be rejected with
# 400. Corrections only via Storno-Buchung.
# §146 AO GoBD: immutability of closed periods.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: closed day is immutable (PUT / DELETE rejected) ==="

# Seed: eroeffnung + 1 einnahme on 6/1
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-01\",
  \"type\":\"eroeffnung\",
  \"description\":\"Anfangsbestand\",
  \"amount\":500
}" >/dev/null

api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-01\",
  \"type\":\"einnahme\",
  \"description\":\"Barverkauf\",
  \"amount\":100
}"
EID=$(json_field "$BODY" id)
note "Einnahme id: $EID"

# Close the day
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-01\",
  \"physicalCount\":600
}"
assert_status "201" "Z-Bericht 6/1 (physicalCount=600)"

# Now try to PUT the entry
api_put "/api/v1/cashbook/entries/$EID?companyId=$COMPANY_ID" "{
  \"amount\":999
}"
assert_status "400" "PUT on closed day rejected"
echo "$BODY" | grep -qi "Tagesabschluss" && pass "Error mentions Tagesabschluss" || fail "Error should mention Tagesabschluss: $BODY"

# Try to DELETE
api_get_check=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE "$API/api/v1/cashbook/entries/$EID?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
if [[ "$api_get_check" == "400" ]]; then
  pass "DELETE on closed day rejected (HTTP 400)"
else
  fail "DELETE on closed day should be 400, got $api_get_check"
fi

# And the original row is still there
COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"CashBookEntry\" WHERE id = '$EID';" 2>/dev/null | tr -d ' ')
assert_eq "Original entry still in DB after rejected DELETE" "$COUNT" "1"

# But Storno IS allowed on a closed day
api_post "/api/v1/cashbook/entries/$EID/reverse?companyId=$COMPANY_ID" "{
  \"reason\":\"Test-Korrektur\",
  \"createdById\":\"$USER_ID\"
}"
assert_status "201" "Storno on closed day allowed"

# Close record was marked amended
amended=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"amendedAt\" IS NOT NULL FROM \"CashBookDailyClose\" WHERE \"companyId\" = '$COMPANY_ID' AND \"businessDate\" = '2026-06-01';" 2>/dev/null | tr -d ' ')
assert_eq "Close record marked amended after Storno" "$amended" "t"

cleanup_cashbook
summary
