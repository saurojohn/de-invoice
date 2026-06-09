#!/bin/bash
# Test 05: Input validation.
# - amount must be > 0
# - description is required
# - type must be one of the 4 valid types
# These guards live in createEntry().

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: input validation ==="

# Need an eroeffnung first so other tests are valid
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"eroeffnung\",
  \"description\":\"Anfangsbestand\",\"amount\":100
}" >/dev/null

# Negative amount → 400
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"Negative\",\"amount\":-50
}"
assert_status "400" "Negative amount rejected"
echo "$BODY" | grep -qi "Betrag" && pass "Error mentions Betrag" || fail "Should mention Betrag: $BODY"

# Zero amount → 400
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"Zero\",\"amount\":0
}"
assert_status "400" "Zero amount rejected"

# Empty description → 400
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"\",\"amount\":10
}"
assert_status "400" "Empty description rejected"
echo "$BODY" | grep -qi "Beschreibung" && pass "Error mentions Beschreibung" || fail "Should mention Beschreibung: $BODY"

# Whitespace-only description → 400
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"   \",\"amount\":10
}"
assert_status "400" "Whitespace-only description rejected"

# Invalid type → 400
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"loot\",
  \"description\":\"Test\",\"amount\":10
}"
assert_status "400" "Invalid type 'loot' rejected"

# Valid: smallest reasonable entry
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"Test 0.01\",\"amount\":0.01
}"
assert_status "201" "0.01€ entry accepted"

cleanup_cashbook
summary
