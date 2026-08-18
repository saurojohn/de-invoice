#!/usr/bin/env bash
# e2e 96: Tier 69 — DATEV-Export Preview.
#
# Validates the new GET /reports/datev-preview
# endpoint that the /dashboard/reports
# DATEV-Export tab depends on. The endpoint
# runs the same buildBuchungenFromDb pipeline
# the CSV export uses, but returns a JSON
# summary instead of a CSV stream.
#
# Scenarios:
#   1. Default period (YTD) returns a non-empty
#      preview.
#   2. Header has Berater-/Mandanten-Nr + filename.
#   3. rowCount > 0 (SH Leder has 100+ paid
#      invoices from prior tiers).
#   4. balanceDelta ≈ 0 (Soll == Haben).
#   5. byAccount includes 8400 (Erlöse 19% USt).
#   6. firstRows has 5 entries, each with
#      belegdatum / belegfeld1 / konto /
#      gegenkonto / betrag / shVz.
#   7. Custom period (single day) returns 0 rows
#      for an empty day.
#   8. issues array is present (may be empty
#      when balanced).
#   9. 400 for missing companyId.
#  10. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
stash() { printf '%s' "$BODY" > "$1"; }
jsf() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))" < "$2"; }

# ───── 1. Default period returns non-empty preview ─────
echo
note "=== 1. default period (YTD) ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID"
assert_eq "preview 200" "$STATUS" "200"
TMP=$(mktemp); stash "$TMP"
RC=$(jsf rowCount "$TMP")
test "$RC" -gt 0 || fail "rowCount too small: $RC"
pass "rowCount=$RC"
rm -f "$TMP"

# ───── 2. Header has Berater-/Mandanten-Nr + filename ─────
echo
note "=== 2. header ==="
TMP=$(mktemp); stash "$TMP"
BERATER=$(python3 -c "import json,sys; print(json.load(sys.stdin)['header']['beraterNr'])" < "$TMP")
MANDANT=$(python3 -c "import json,sys; print(json.load(sys.stdin)['header']['mandantenNr'])" < "$TMP")
FILENAME=$(python3 -c "import json,sys; print(json.load(sys.stdin)['header']['filename'])" < "$TMP")
test -n "$BERATER" || fail "beraterNr empty"
test -n "$MANDANT" || fail "mandantenNr empty"
test -n "$FILENAME" || fail "filename empty"
pass "berater=$BERATER mandant=$MANDANT file=$FILENAME"
rm -f "$TMP"

# ───── 3. rowCount > 0 ─────
echo
note "=== 3. rowCount > 0 ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31"
TMP=$(mktemp); stash "$TMP"
RC=$(jsf rowCount "$TMP")
test "$RC" -gt 100 || fail "rowCount too small: $RC (expected >100)"
pass "rowCount=$RC (>100)"
rm -f "$TMP"

# ───── 4. balanceDelta ≈ 0 ─────
echo
note "=== 4. balanceDelta ≈ 0 ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31"
TMP=$(mktemp); stash "$TMP"
DELTA=$(python3 -c "import json,sys; print(abs(float(json.load(sys.stdin)['balanceDelta'])))" < "$TMP")
# Use python3 for the float comparison (bash
# test -lt is integer-only).
LT_OK=$(python3 -c "print('yes' if float('$DELTA') < 0.01 else 'no')")
assert_eq "balanceDelta < 0.01" "$LT_OK" "yes"
pass "balanceDelta=$DELTA (<0.01)"
rm -f "$TMP"

# ───── 5. byAccount includes 8400 (Erlöse 19% USt) ─────
echo
note "=== 5. byAccount includes 8400 ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31"
TMP=$(mktemp); stash "$TMP"
HAS_8400=$(python3 -c "import json,sys
g = json.load(sys.stdin)['byAccount']
print('yes' if any(a['konto']=='8400' for a in g) else 'no')" < "$TMP")
assert_eq "byAccount has 8400" "$HAS_8400" "yes"
rm -f "$TMP"

# ───── 6. firstRows has 5 entries with required fields ─────
echo
note "=== 6. firstRows shape ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31"
TMP=$(mktemp); stash "$TMP"
ROWS_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['firstRows']))" < "$TMP")
assert_eq "firstRows length" "$ROWS_LEN" "5"
SHAPE_OK=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
required = {'belegdatum','belegfeld1','konto','gegenkonto','betrag','shVz'}
for r in data['firstRows']:
  if set(r.keys()) & required != required:
    print('missing')
    sys.exit(1)
print('ok')" < "$TMP")
assert_eq "firstRows shape" "$SHAPE_OK" "ok"
rm -f "$TMP"

# ───── 7. Empty single-day period returns 0 rows ─────
echo
note "=== 7. single empty day → 0 rows ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=1990-01-01&endDate=1990-01-01"
TMP=$(mktemp); stash "$TMP"
RC_E=$(jsf rowCount "$TMP")
assert_eq "empty period rowCount=0" "$RC_E" "0"
ROWS_E=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['firstRows']))" < "$TMP")
assert_eq "empty period firstRows=0" "$ROWS_E" "0"
rm -f "$TMP"

# ───── 8. issues is always an array (even when empty) ─────
echo
note "=== 8. issues is array ==="
api_get "/api/v1/reports/datev-preview?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31"
TMP=$(mktemp); stash "$TMP"
ISSUES_TYPE=$(python3 -c "import json,sys; print(type(json.load(sys.stdin)['issues']).__name__)" < "$TMP")
assert_eq "issues is list" "$ISSUES_TYPE" "list"
rm -f "$TMP"

# ───── 9. 400 for missing companyId ─────
echo
note "=== 9. missing companyId → 400 ==="
api_get "/api/v1/reports/datev-preview"
assert_eq "missing companyId 400" "$STATUS" "400"

# ───── 10. Cross-tenant → 401 ─────
echo
note "=== 10. cross-tenant → 401 ==="
CROSS_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X GET "$API/api/v1/reports/datev-preview?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant 401" "$CROSS_STATUS" "401"

# ───── 11. Cleanup (no DB writes) ─────
echo
note "=== 11. nothing to clean up ==="
pass "tier 69 is read-only"

summary
exit $?
