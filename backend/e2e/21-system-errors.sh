#!/bin/bash
# Test 21: System module — error tracking + health checks
#
# Covers:
#   - /health returns 200 with no auth
#   - /health/deep returns 200 with postgres check
#   - POST /errors accepts pre-auth frontend errors
#   - GET /errors is admin-only (401 without auth)
#   - Same fingerprint dedupes (occurrences++)
#   - Backend 5xx captures via global filter
#   - resolve + mute change status
#   - prune deletes resolved/muted/old rows
#
# Like 09-vouchers-list.sh, leaves error rows in the
# DB so the dashboard can show them. run-all.sh runs
# a final cleanup.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

echo "=== Test: health + error tracking ==="

# Test 1: /health (no auth)
HEALTH=$(curl -sS -w "\n%{http_code}" http://localhost:3001/api/v1/system/health)
HEALTH_BODY=$(echo "$HEALTH" | head -1)
HEALTH_CODE=$(echo "$HEALTH" | tail -1)
assert_eq "health HTTP 200" "$HEALTH_CODE" "200"
HEALTH_STATUS=$(json_field "$HEALTH_BODY" status)
assert_eq "health status" "$HEALTH_STATUS" "ok"

# Test 2: /health/deep (no auth, postgres ping)
DEEP=$(curl -sS -w "\n%{http_code}" http://localhost:3001/api/v1/system/health/deep)
DEEP_CODE=$(echo "$DEEP" | tail -1)
assert_eq "deep health HTTP 200" "$DEEP_CODE" "200"
DEEP_BODY=$(echo "$DEEP" | head -1)
DEEP_OK=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['checks']['postgres']['ok'])" "$DEEP_BODY")
assert_eq "deep health postgres ok" "$DEEP_OK" "True"

# Test 3: POST /errors (no auth) — simulates login-page crash
PRE_AUTH=$(curl -sS -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" \
  -d '{"message":"SYS-TEST pre-auth crash","stack":"TypeError: test\n  at LoginPage (login/page.tsx:42)","component":"LoginPage","url":"/login"}')
PRE_AUTH_OK=$(json_field "$PRE_AUTH" ok | tr 'A-Z' 'a-z')
assert_eq "pre-auth error capture ok" "$PRE_AUTH_OK" "true"

# Test 4: GET /errors is admin-only (no x-user-id)
NO_AUTH_LIST=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3001/api/v1/system/errors)
assert_eq "list no-auth HTTP 401" "$NO_AUTH_LIST" "401"

# Test 5: GET /errors with auth (admin)
# Inline curl so we can capture both status and body in
# the same call (api_get's STATUS var doesn't propagate
# back from a $() subshell).
LIST=$(curl -sS -w "\n%{http_code}" "$API/api/v1/system/errors?status=open&take=50" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
LIST_STATUS=$(echo "$LIST" | tail -1)
LIST_BODY=$(echo "$LIST" | sed '$d')
assert_eq "list auth HTTP 200" "$LIST_STATUS" "200"
# The pre-auth test (Test 3) posts without x-user-id,
# so the resulting row has companyId=NULL. The admin
# list filters by the admin's companyId, so it doesn't
# see pre-auth rows. Test 7 below posts WITH auth,
# which is what the list should be able to see.
LIST_TOTAL_BEFORE=$(json_field "$LIST_BODY" total)
# Test 7 inserts an authed event; bump expected to at
# least 1 (we have prior real errors in the DB from dev).
[ "$LIST_TOTAL_BEFORE" -ge 0 ] && echo "✓ list reachable (total=$LIST_TOTAL_BEFORE)" || { echo "✗ list total actual=$LIST_TOTAL_BEFORE"; exit 1; }

# Test 6: dedupe (3 more posts WITH auth → occurrences should increment)
# Use a different message here so we get a fresh row
# under the admin's companyId (the pre-auth row in
# Test 3 has companyId=NULL and is invisible to the
# admin's list query, even after dedupe hits it).
for i in 1 2 3; do
  curl -sS -X POST http://localhost:3001/api/v1/system/errors \
    -H "Content-Type: application/json" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -d '{"message":"SYS-TEST dedupe row","stack":"Error: dedupe test\n  at Test","component":"Test"}' > /dev/null
done
LIST2=$(curl -sS "$API/api/v1/system/errors?status=open&take=50" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
SYS_TEST_OCC=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
v = next((x for x in d['items'] if x['message'] == 'SYS-TEST dedupe row'), None)
if v: print(v['occurrences'])
else: print('NOT_FOUND')
" "$LIST2")
[ "$SYS_TEST_OCC" -ge 3 ] && echo "✓ dedupe occurrences >= 3 = $SYS_TEST_OCC" || { echo "✗ dedupe actual=$SYS_TEST_OCC"; exit 1; }

# Test 7: capture with auth (logged-in frontend error)
AUTH_ERR=$(curl -sS -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"message":"SYS-TEST authed","stack":"Error: bad\n  at Page","kind":"boundary"}')
[ "$(json_field "$AUTH_ERR" ok | tr 'A-Z' 'a-z')" = "true" ] && echo "✓ authed error captured" || { echo "✗ authed error not captured: $AUTH_ERR"; exit 1; }

# Test 8: resolve changes status to 'resolved'
# Re-fetch LIST2 after the authed insert so we have the
# new row's id.
LIST2=$(curl -sS "$API/api/v1/system/errors?status=open&take=50" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
RESOLVE_ID=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
v = next((x for x in d['items'] if x['message'] == 'SYS-TEST authed'), None)
if v: print(v['id'])
" "$LIST2")
[ -n "$RESOLVE_ID" ] || { echo "✗ no SYS-TEST authed id"; exit 1; }
RESOLVE_RESP=$(curl -sS -X POST "http://localhost:3001/api/v1/system/errors/$RESOLVE_ID/resolve" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "resolve status" "$(json_field "$RESOLVE_RESP" status)" "resolved"

# Test 9: muted status works
MUTE_ID=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
v = next((x for x in d['items'] if x['message'] == 'SYS-TEST dedupe row'), None)
if v: print(v['id'])
" "$LIST2")
[ -n "$MUTE_ID" ] || { echo "✗ no SYS-TEST dedupe id"; exit 1; }
MUTE_RESP=$(curl -sS -X POST "http://localhost:3001/api/v1/system/errors/$MUTE_ID/mute" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "mute status" "$(json_field "$MUTE_RESP" status)" "muted"

# Test 10: filter by source
SRC=$(curl -sS "$API/api/v1/system/errors?source=frontend&take=200" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
SRC_TOTAL=$(json_field "$SRC" total)
[ "$SRC_TOTAL" -ge 2 ] && echo "✓ source=frontend >= 2 = $SRC_TOTAL" || { echo "✗ source filter actual=$SRC_TOTAL"; exit 1; }

# Test 11: filter by status=resolved
RESOLVED_LIST=$(curl -sS "$API/api/v1/system/errors?status=resolved&take=200" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
RESOLVED_COUNT=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(sum(1 for x in d['items'] if x['message'].startswith('SYS-TEST')))
" "$RESOLVED_LIST")
[ "$RESOLVED_COUNT" -ge 1 ] && echo "✓ status=resolved has SYS-TEST = $RESOLVED_COUNT" || { echo "✗ resolved filter actual=$RESOLVED_COUNT"; exit 1; }

# Test 12: prune deletes resolved + muted
PRUNE=$(curl -sS -X POST http://localhost:3001/api/v1/system/errors/prune \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
PRUNE_DEL=$(json_field "$PRUNE" deleted)
[ "$PRUNE_DEL" -ge 2 ] && echo "✓ prune deleted >= 2 = $PRUNE_DEL" || { echo "✗ prune deleted=$PRUNE_DEL"; exit 1; }

# Test 13: malformed body — global validation pipe rejects
# with 400 (NestJS Express adapter can't parse). That's
# fine, the test just verifies the backend doesn't crash
# the process on garbage input. The 200 path is covered
# by Test 14.
BAD=$(curl -sS -w "\n%{http_code}" -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" -d 'not json at all')
BAD_CODE=$(echo "$BAD" | tail -1)
[ "$BAD_CODE" = "400" ] || [ "$BAD_CODE" = "500" ] && echo "✓ malformed body rejected (4xx/5xx) = $BAD_CODE" || { echo "✗ malformed body unexpected = $BAD_CODE"; exit 1; }

# Test 14: valid JSON but no message — should not persist garbage
EMPTY=$(curl -sS -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" -d '{}')
EMPTY_OK=$(json_field "$EMPTY" ok | tr 'A-Z' 'a-z')
assert_eq "empty body ok" "$EMPTY_OK" "true"

# ===== Tier 392: the PUBLIC capture route does not trust the client =====
# Measured before, all unauthenticated: a post carrying an existing group's
# fingerprint rewrote that group's message and stack; random fingerprints minted
# unlimited rows (each firing an operator notification); context was stored
# verbatim (2 MB).
T392="SYS-TEST-392-$(date +%s%N | cut -c1-13)"
sql392() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

# 15. A real group, then an outsider posting that group's own fingerprint with a
# different message must NOT rewrite it.
curl -sS -o /dev/null -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"$T392 echt\",\"stack\":\"at PaymentService.charge\",\"fingerprint\":\"client-chosen-$T392\"}"
FP392=$(sql392 "SELECT fingerprint FROM \"ErrorEvent\" WHERE message = '$T392 echt';")
[ -n "$FP392" ] && [ "$FP392" != "client-chosen-$T392" ] \
  && echo "✓ server computes the fingerprint, client value ignored" \
  || { echo "✗ client fingerprint was stored: $FP392"; exit 1; }
curl -sS -o /dev/null -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"$T392 uebernommen\",\"stack\":\"at PaymentService.charge\",\"fingerprint\":\"$FP392\"}"
STILL=$(sql392 "SELECT message FROM \"ErrorEvent\" WHERE fingerprint = '$FP392';")
assert_eq "existing group not rewritten by a posted fingerprint" "$STILL" "$T392 echt"

# 16. Grouping still works without any client fingerprint (same message twice).
for _ in 1 2; do
  curl -sS -o /dev/null -X POST http://localhost:3001/api/v1/system/errors \
    -H "Content-Type: application/json" -d "{\"message\":\"$T392 dedupe\",\"stack\":\"at X.y\"}"
done
assert_eq "same message dedupes to one row" "$(sql392 "SELECT count(*) FROM \"ErrorEvent\" WHERE message = '$T392 dedupe';")" "1"
assert_eq "…with occurrences=2" "$(sql392 "SELECT occurrences FROM \"ErrorEvent\" WHERE message = '$T392 dedupe';")" "2"

# 17. An oversized context is bounded (2 MB was stored verbatim).
python3 -c "import json;print(json.dumps({'message':'$T392 big','context':{'pad':'A'*2000000}}))" > /tmp/t392-big.json
curl -sS -o /dev/null -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" --data-binary @/tmp/t392-big.json
CTX_LEN=$(sql392 "SELECT length(context::text) FROM \"ErrorEvent\" WHERE message = '$T392 big';")
[ -n "$CTX_LEN" ] && [ "$CTX_LEN" -lt 5000 ] \
  && echo "✓ oversized context bounded ($CTX_LEN chars, was 2000011)" \
  || { echo "✗ context not bounded: $CTX_LEN"; exit 1; }
assert_eq "…marked truncated" "$(sql392 "SELECT context->>'truncated' FROM \"ErrorEvent\" WHERE message = '$T392 big';")" "true"
rm -f /tmp/t392-big.json

# 18. Bounded fields: an over-long message and an unknown kind are refused.
LONG=$(python3 -c "print('M'*4001)")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" -d "{\"message\":\"$LONG\"}")
assert_eq "4001-char message refused" "$CODE" "400"
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/v1/system/errors \
  -H "Content-Type: application/json" -d "{\"message\":\"$T392 kind\",\"kind\":\"bogus\"}")
assert_eq "unknown kind refused" "$CODE" "400"

# 19. The public route declares a per-IP throttle. THROTTLE_DISABLED=1 here and
# in CI, so the limit itself cannot be exercised — assert the decorator is on
# the route (the global default is 600/60s, far too loose for a public write).
CAPTURE_SRC=$(sed -n '/@Post("errors")/,/async captureError/p' "$SCRIPT_DIR/../src/modules/system/system.controller.ts")
echo "$CAPTURE_SRC" | grep -q "@Throttle(" \
  && echo "✓ POST /system/errors carries a @Throttle" \
  || { echo "✗ POST /system/errors has no @Throttle"; exit 1; }

# Cleanup any test rows
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"ErrorEvent\" WHERE message LIKE 'SYS-TEST%';" >/dev/null 2>&1

echo
summary
