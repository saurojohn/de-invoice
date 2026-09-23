#!/bin/bash
# Test 03: Storno (reversal) is net-zero on the balance.
# A 100€ einnahme that is then storniert must leave the
# Kassenbestand unchanged (€0 net).
# GoBD §146 AO: corrections preserve historical accuracy.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Storno is net zero on balance ==="

# 1 einnahme 100€
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-09\",
  \"type\":\"einnahme\",
  \"description\":\"Test einnahme\",
  \"amount\":100
}"
EID=$(json_field "$BODY" id)
note "einnahme id: $EID"

# Balance before: 100
api_get "/api/v1/cashbook/balance?companyId=$COMPANY_ID"
B_BEFORE=$(json_field "$BODY" balance)
E_BEFORE=$(json_field "$BODY" einnahmen)
assert_eq "balance before storno" "$B_BEFORE" "100"
assert_eq "einnahmen before storno" "$E_BEFORE" "100"

# Storno it
api_post "/api/v1/cashbook/entries/$EID/reverse?companyId=$COMPANY_ID" "{
  \"reason\":\"Test-Korrektur\",
  \"createdById\":\"$USER_ID\"
}"
assert_status "201" "Storno created"

# Balance after: should be 0
api_get "/api/v1/cashbook/balance?companyId=$COMPANY_ID"
B_AFTER=$(json_field "$BODY" balance)
E_AFTER=$(json_field "$BODY" einnahmen)
assert_eq "balance after storno (net zero)" "$B_AFTER" "0"
assert_eq "einnahmen after storno (net zero)" "$E_AFTER" "0"

# Storno without reason must be rejected. (Tier 435: an Einnahme — an
# Ausgabe of 50 from the till the Storno just emptied is refused now.)
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",
  \"businessDate\":\"2026-06-09\",
  \"type\":\"einnahme\",
  \"description\":\"Einnahme 50\",
  \"amount\":50
}"
EID2=$(json_field "$BODY" id)

api_post "/api/v1/cashbook/entries/$EID2/reverse?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\"
}"
assert_status "400" "Storno without reason rejected"
echo "$BODY" | grep -qi "Begründung" && pass "Error mentions Begründung" || fail "Should mention Begründung: $BODY"

# Storno a Storno (chained reversal) is forbidden
api_post "/api/v1/cashbook/entries/$EID/reverse?companyId=$COMPANY_ID" "{
  \"reason\":\"another\",
  \"createdById\":\"$USER_ID\"
}"
# Tier 376: reversesId is unique — this second storno of the same entry used to
# fail in Postgres and answer 500, unasserted. It is a 400 now.
assert_status "400" "second storno of the same entry rejected"
echo "$BODY" | grep -q "bereits storniert" && pass "Error says already reversed" || fail "Should say bereits storniert: $BODY"
# EID is the original; its reversal has reversesId=EID. So trying
# to storno the original again would create a second reversal which
# is technically allowed (because the original is not itself a
# reversal). But if we try to storno the REVERSAL row, that fails.
# Fetch the reversal row id:
REVID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"CashBookEntry\" WHERE \"reversesId\" = '$EID' LIMIT 1;" 2>/dev/null | tr -d ' ')
api_post "/api/v1/cashbook/entries/$REVID/reverse?companyId=$COMPANY_ID" "{
  \"reason\":\"trying to reverse a storno\",
  \"createdById\":\"$USER_ID\"
}"
assert_status "400" "Cannot storno a Storno (reversal)"
echo "$BODY" | grep -qi "bereits eine Storno-Buchung" && pass "Error mentions already a Storno" || fail "Should mention Storno: $BODY"

cleanup_cashbook
summary
