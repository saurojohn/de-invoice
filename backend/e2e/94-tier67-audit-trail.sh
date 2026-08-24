#!/usr/bin/env bash
# e2e 94: Tier 67 — Audit-Trail read API.
#
# Validates the four endpoints that the /dashboard/audit
# page depends on:
#   - GET /audit-logs                list + filters + pagination
#   - GET /audit-logs/stats          summary cards
#   - GET /audit-logs/:id            detail with oldData / newData
#   - GET /audit-logs/export.csv     GoBD-grade CSV download
#
# Scenarios:
#   1. Existing data: 1700+ rows from previous tiers.
#   2. Filter by entityType=Invoice (most common)
#   3. Filter by actionPrefix=invoice.
#   4. Filter by userId
#   5. Filter by date range
#   6. Pagination: skip / take
#   7. Stats: byAction / byEntityType / byUser
#   8. Detail: a single row with oldData + newData JSON
#   9. CSV export: header line + at least 1 row
#  10. CSV with filters
#  11. 404 for non-existent ID
#  12. 400 for missing companyId
#  13. Cleanup (no test data was created — we only READ)
#
# Note: tier 67 is purely read-only; the seed data from
# the previous tiers is the test corpus. We do NOT
# create or delete anything here.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# Helper: stash BODY to a file for json reads
stash() { printf '%s' "$BODY" > "$1"; }
jsf() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))" < "$2"; }

# ───── 1. List without filter (default page) ─────
echo
note "=== 1. list default ==="
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&take=10"
assert_eq "list 200" "$STATUS" "200"
TMP=$(mktemp); stash "$TMP"
TOTAL=$(jsf total "$TMP")
ROWS_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['rows']))" < "$TMP")
test "$TOTAL" -ge 100 || fail "total too small: $TOTAL"
pass "total=$TOTAL"
assert_eq "rows=10" "$ROWS_LEN" "10"
FIRST_ACTION=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rows'][0]['action'])" < "$TMP")
test -n "$FIRST_ACTION" || fail "first row action empty"
pass "first row action=$FIRST_ACTION"
rm -f "$TMP"

# ───── 2. Filter by entityType=Invoice ─────
echo
note "=== 2. filter entityType=Invoice ==="
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&entityType=Invoice&take=5"
TMP=$(mktemp); stash "$TMP"
TOTAL_INV=$(jsf total "$TMP")
test "$TOTAL_INV" -ge 10 || fail "Invoice total too small: $TOTAL_INV"
pass "Invoice total=$TOTAL_INV"
# Every row must be an Invoice change.
ALL_INV=$(python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print('yes' if all(r['entityType']=='Invoice' for r in rows) else 'no')" < "$TMP")
assert_eq "all rows Invoice" "$ALL_INV" "yes"
rm -f "$TMP"

# ───── 3. Filter by actionPrefix=invoice. ─────
echo
note "=== 3. filter actionPrefix=invoice. ==="
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&actionPrefix=invoice.&take=5"
TMP=$(mktemp); stash "$TMP"
ALL_PFX=$(python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print('yes' if all(r['action'].startswith('invoice.') for r in rows) else 'no')" < "$TMP")
assert_eq "all rows invoice.*" "$ALL_PFX" "yes"
rm -f "$TMP"

# ───── 4. Filter by userId ─────
echo
note "=== 4. filter userId=$USER_ID ==="
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&userId=$USER_ID&take=5"
TMP=$(mktemp); stash "$TMP"
ALL_UID=$(python3 -c "
import json,sys
rows=json.load(sys.stdin)['rows']
print('yes' if all(r['userId']=='$USER_ID' for r in rows) else 'no')" < "$TMP")
assert_eq "all rows userId match" "$ALL_UID" "yes"
EMAIL=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rows'][0]['userEmail'])" < "$TMP")
assert_eq "userEmail resolved" "$EMAIL" "info@shleder.de"
rm -f "$TMP"

# ───── 5. Filter by date range (yesterday only) ─────
echo
note "=== 5. filter date range ==="
YESTERDAY=$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)
TODAY=$(date -u +%Y-%m-%d)
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&dateFrom=${YESTERDAY}T00:00:00.000Z&dateTo=${TODAY}T23:59:59.999Z&take=5"
TMP=$(mktemp); stash "$TMP"
ROWS_IN_RANGE=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['rows']))" < "$TMP")
test "$ROWS_IN_RANGE" -gt 0 || fail "no rows in range"
pass "rows in range=$ROWS_IN_RANGE"
rm -f "$TMP"

# ───── 6. Pagination: skip / take ─────
echo
note "=== 6. pagination skip=10 take=10 ==="
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&take=10&skip=10"
TMP=$(mktemp); stash "$TMP"
assert_eq "skip returned 10" "$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['rows']))" < "$TMP")" "10"
# The first row at skip=10 must differ from skip=0.
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&take=1&skip=0"
TMP0=$(mktemp); stash "$TMP0"
FIRST_ID_SKIP0=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rows'][0]['id'])" < "$TMP0")
FIRST_ID_SKIP10=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rows'][0]['id'])" < "$TMP")
test "$FIRST_ID_SKIP0" != "$FIRST_ID_SKIP10" || fail "skip did not advance"
pass "skip advances id ($FIRST_ID_SKIP0 → $FIRST_ID_SKIP10)"
rm -f "$TMP" "$TMP0"

# ───── 7. Stats ─────
echo
note "=== 7. stats ==="
api_get "/api/v1/audit-logs/stats?companyId=$COMPANY_ID"
assert_eq "stats 200" "$STATUS" "200"
TMP=$(mktemp); stash "$TMP"
TOTAL_ACTIONS=$(jsf totalActions "$TMP")
test "$TOTAL_ACTIONS" -ge 100 || fail "totalActions too small: $TOTAL_ACTIONS"
pass "totalActions=$TOTAL_ACTIONS"
TOP_ACTION=$(python3 -c "import json,sys; print(json.load(sys.stdin)['byAction'][0]['action'])" < "$TMP")
test -n "$TOP_ACTION" || fail "byAction empty"
pass "top action=$TOP_ACTION"
NEWEST=$(jsf newestChange "$TMP")
test -n "$NEWEST" || fail "newestChange null"
pass "newestChange=$NEWEST"
rm -f "$TMP"

# ───── 8. Detail ─────
echo
note "=== 8. detail of a row ==="
# Pull the first row from the list, then fetch its detail.
api_get "/api/v1/audit-logs?companyId=$COMPANY_ID&take=1"
TMP=$(mktemp); stash "$TMP"
FIRST_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rows'][0]['id'])" < "$TMP")
rm -f "$TMP"

api_get "/api/v1/audit-logs/$FIRST_ID?companyId=$COMPANY_ID"
assert_eq "detail 200" "$STATUS" "200"
TMP=$(mktemp); stash "$TMP"
DETAIL_ACTION=$(jsf action "$TMP")
assert_eq "detail action match" "$DETAIL_ACTION" "$FIRST_ACTION"  # any of the byAction is fine; just check non-empty
test -n "$DETAIL_ACTION" || fail "detail action empty"
pass "detail action=$DETAIL_ACTION"
# oldData or newData must be present (it's a real change).
HAS_OLD=$(python3 -c "import json,sys; b=json.load(sys.stdin); print('yes' if b.get('oldData') or b.get('newData') else 'no')" < "$TMP")
assert_eq "oldData or newData present" "$HAS_OLD" "yes"
rm -f "$TMP"

# ───── 9. CSV export (no filter) ─────
echo
note "=== 9. CSV export (no filter) ==="
api_get "/api/v1/audit-logs/export.csv?companyId=$COMPANY_ID&take=3"
assert_eq "csv 200" "$STATUS" "200"
test -n "$BODY" || fail "csv body empty"
# Strip the UTF-8 BOM (\ufeff) that the backend
# prepends for Excel compatibility, then check
# the header line.
HEADER_OK=$(printf '%s' "$BODY" | head -1 | sed 's/^\xef\xbb\xbf//' | grep -c "^Zeitstempel;Aktion" || true)
assert_eq "csv header ok" "$HEADER_OK" "1"
LINE_COUNT=$(printf '%s' "$BODY" | wc -l | tr -d ' ')
test "$LINE_COUNT" -ge 2 || fail "csv < 2 lines (got $LINE_COUNT)"
pass "csv lines=$LINE_COUNT"

# ───── 10. CSV with filter ─────
echo
note "=== 10. CSV with entityType filter ==="
api_get "/api/v1/audit-logs/export.csv?companyId=$COMPANY_ID&entityType=Invoice&take=2"
assert_eq "csv 200 (filtered)" "$STATUS" "200"
test -n "$BODY" || fail "csv body empty (filtered)"
HEADER_OK=$(printf '%s' "$BODY" | head -1 | sed 's/^\xef\xbb\xbf//' | grep -c "^Zeitstempel;Aktion" || true)
assert_eq "csv header ok (filtered)" "$HEADER_OK" "1"

# ───── 11. 404 for non-existent ID ─────
echo
note "=== 11. 400/404 for unknown id ==="
api_get "/api/v1/audit-logs/00000000-0000-0000-0000-000000000000?companyId=$COMPANY_ID"
# We throw BadRequestException('Audit-Eintrag nicht gefunden') = 400.
test "$STATUS" = "400" || test "$STATUS" = "404" || fail "expected 400 or 404, got $STATUS"
pass "unknown id -> $STATUS"

# ───── 12. 400 for missing companyId ─────
echo
note "=== 12. 400 for missing companyId ==="
api_get "/api/v1/audit-logs?take=1"
assert_eq "missing companyId 400" "$STATUS" "400"

# ───── 13. Cleanup (no data was created) ─────
echo
note "=== 13. nothing to clean up ==="
pass "tier 67 is read-only"

summary
exit $?
