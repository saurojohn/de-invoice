#!/bin/bash
# Test 04: Z-Bericht (Tagesabschluss) requires a differenz note
# when physicalCount ≠ calculated endbestand.
# The differenz is physicalCount - endbestand.
# Zero differenz doesn't need a note; non-zero requires one.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Z-Bericht with non-zero differenz requires note ==="

# Setup: 500 + 100 einnahme + 50 ausgabe → endbestand 550
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-09\",\"type\":\"eroeffnung\",
  \"description\":\"Anfangsbestand\",\"amount\":500
}" >/dev/null
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-09\",\"type\":\"einnahme\",
  \"description\":\"Einnahme\",\"amount\":100
}" >/dev/null
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-09\",\"type\":\"ausgabe\",
  \"description\":\"Ausgabe\",\"amount\":50
}" >/dev/null

# Z-Bericht with EXACT count → 200 OK without note
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":550
}"
assert_status "201" "Z-Bericht exact count (no note needed)"

# Reopen and try with differenz -1.10 and no note → 400
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" "{ \"date\":\"2026-06-09\" }" >/dev/null

api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":548.90
}"
assert_status "400" "Z-Bericht differenz -1.10 without note rejected"
echo "$BODY" | grep -qi "Begründung\|note\|differenz" && pass "Error mentions Begründung" || fail "Should mention Begründung: $BODY"

# Now WITH a note → 201
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" "{ \"date\":\"2026-06-09\" }" >/dev/null

api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":548.90,
  \"differenzNote\":\"Bon 17 verloren\"
}"
assert_status "201" "Z-Bericht differenz -1.10 with note accepted"
DIF=$(json_field "$BODY" differenz)
assert_close "differenz recorded" "$DIF" "-1.10" 0.01

# Reopen and try with overage +1.20 and no note → 400
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" "{ \"date\":\"2026-06-09\" }" >/dev/null

api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":551.20
}"
assert_status "400" "Z-Bericht differenz +1.20 (overage) without note rejected"

# With note
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" "{ \"date\":\"2026-06-09\" }" >/dev/null

api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":551.20,
  \"differenzNote\":\"Spende vom Chef\"
}"
assert_status "201" "Z-Bericht differenz +1.20 with note accepted"

# Reclose an already-closed day → 400
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-06-09\",
  \"physicalCount\":551.20
}"
assert_status "400" "Reclose already-closed day rejected"

# Close an empty day → 400
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{
  \"date\":\"2026-07-01\",
  \"physicalCount\":0
}"
assert_status "400" "Close empty day rejected"

cleanup_cashbook
summary
