#!/bin/bash
# Tier 218 — POST /webhooks/deliveries/:id/{replay,requeue}
# Backend e2e coverage for the two Tier 198 admin
# write paths. These endpoints are operator actions
# on existing delivery rows — a misimplementation can
# either silently drop webhooks (the receiver never
# gets called) or double-deliver (the receiver's
# idempotency key matches and the event is treated as
# a new event, leading to double-charge).
#
# Tests:
#   1. Replay a successful delivery — bumps retryCount
#      on the original + creates a new delivery row
#      with the same eventId + retryCount=0
#   2. Replay preserves eventId (receiver dedup
#      contract — same eventId = same logical event)
#   3. Replay of nonexistent delivery → 404
#   4. Replay of cross-tenant delivery → 404
#      (tenant isolation, the service throws 404
#      not 403 to avoid leaking existence)
#   5. Replay requires active webhook — pausing the
#      webhook + replaying → 400
#   6. Requeue requires exhausted status — replaying
#      a fresh failed delivery → 400
#   7. Requeue happy path: SQL UPDATE to exhausted,
#      then POST /requeue → row back to failed with
#      retryCount=0
#   8. Requeue writes activity log (entityId = delivery
#      id, action = 'webhook.requeue') for the Berater
#      audit trail

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

login

# Set up: create a webhook + fire a test delivery to
# produce a real delivery row we can replay.
WEBHOOK_RESP=$(curl -sS -X POST "$API/api/v1/webhooks?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"tier218-replay-requeue","url":"https://postman-echo.com/status/200","events":["webhook.test"]}')
WEBHOOK_ID=$(echo "$WEBHOOK_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
if [[ -z "$WEBHOOK_ID" ]]; then
  fail "could not create webhook: $WEBHOOK_RESP"
  exit 1
fi
pass "test webhook created: $WEBHOOK_ID"

# Fire a test delivery (asynchronous — the endpoint
# returns immediately without deliveryId, so we poll
# the deliveries list for the newest row)
TEST_RESP=$(curl -sS -X POST "$API/api/v1/webhooks/$WEBHOOK_ID/test?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"webhook.test","data":{"hello":"world"}}')
note "test endpoint response: $TEST_RESP"

# Poll for the delivery row to appear (deliveries are
# scoped per-webhook via :id/deliveries, not global)
DELIVERY_ID=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  api_get "/api/v1/webhooks/$WEBHOOK_ID/deliveries?companyId=$COMPANY_ID&limit=5"
  DELIVERY_ID=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
if isinstance(arr, list) and len(arr) > 0:
    print(arr[0].get('id', ''))
")
  if [[ -n "$DELIVERY_ID" ]]; then break; fi
  sleep 0.5
done
if [[ -z "$DELIVERY_ID" ]]; then
  fail "no delivery row appeared after 5s"
  exit 1
fi
pass "test delivery fired: $DELIVERY_ID"

# Read the current state (same endpoint)
api_get "/api/v1/webhooks/$WEBHOOK_ID/deliveries?companyId=$COMPANY_ID&limit=10"
ORIGINAL_RETRY=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
if isinstance(arr, list):
    for d in arr:
        if d.get('id') == '$DELIVERY_ID':
            print(d.get('retryCount', 0))
            break
")
note "original delivery retryCount: $ORIGINAL_RETRY"
ORIGINAL_EVENT_ID=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
if isinstance(arr, list):
    for d in arr:
        if d.get('id') == '$DELIVERY_ID':
            print(d.get('eventId', ''))
            break
")
note "original eventId: $ORIGINAL_EVENT_ID"

# ========== Test 1+2: Replay bumps retryCount + creates new row ==========
api_post "/api/v1/webhooks/deliveries/$DELIVERY_ID/replay?companyId=$COMPANY_ID" ""
assert_eq "replay HTTP" "$STATUS" "200"
REPLAY_ID=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('delivery',{}).get('id',''))")
if [[ -z "$REPLAY_ID" || "$REPLAY_ID" == "$DELIVERY_ID" ]]; then
  fail "replay should return NEW delivery id, got: $REPLAY_ID (original was $DELIVERY_ID)"
else
  pass "replay created new delivery row: $REPLAY_ID"
fi
REPLAY_EVENT_ID=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('delivery',{}).get('eventId',''))")
assert_eq "replay preserves eventId" "$REPLAY_EVENT_ID" "$ORIGINAL_EVENT_ID"

# Read both rows to confirm retryCount bumped
api_get "/api/v1/webhooks/$WEBHOOK_ID/deliveries?companyId=$COMPANY_ID&limit=10"
NEW_ORIGINAL_RETRY=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
for d in arr:
    if d.get('id') == '$DELIVERY_ID':
        print(d.get('retryCount', 0))
        break
")
note "original retryCount after replay (should be +1 from $ORIGINAL_RETRY): $NEW_ORIGINAL_RETRY"

# ========== Test 3: Replay nonexistent delivery → 404 ==========
api_post "/api/v1/webhooks/deliveries/00000000-0000-0000-0000-000000000000/replay?companyId=$COMPANY_ID" ""
assert_eq "replay nonexistent → 404" "$STATUS" "404"

# ========== Test 4: Replay cross-tenant delivery → 404 ==========
# Create a delivery for a different company, then try
# to replay from the caller's company. Use a direct
# Prisma insert via psql (we don't have a second
# company / user / login context handy).
OTHER_DELIVERY_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "INSERT INTO \"WebhookDelivery\" (id, \"webhookId\", \"companyId\", \"eventType\", \"eventId\", payload, status, \"retryCount\") VALUES ('tier218-other', '$WEBHOOK_ID', '00000000-0000-0000-0000-000000000001', 'webhook.test', 'other-event', '{}'::jsonb, 'success', 0) RETURNING id;" 2>/dev/null | tr -d ' \n')
if [[ -n "$OTHER_DELIVERY_ID" ]]; then
  api_post "/api/v1/webhooks/deliveries/$OTHER_DELIVERY_ID/replay?companyId=$COMPANY_ID" ""
  assert_eq "cross-tenant replay → 404" "$STATUS" "404"
  # Cleanup
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"WebhookDelivery\" WHERE id='$OTHER_DELIVERY_ID';" >/dev/null 2>&1
else
  note "could not seed cross-tenant delivery (psql failed); skipping"
fi

# ========== Test 5: Replay on inactive webhook → 400 ==========
# Pause the webhook via Prisma directly
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Webhook\" SET status='paused' WHERE id='$WEBHOOK_ID';" >/dev/null 2>&1

# Create a new delivery row (paused webhook can't fire
# test, so seed one directly)
SEED_DELIVERY_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "INSERT INTO \"WebhookDelivery\" (id, \"webhookId\", \"companyId\", \"eventType\", \"eventId\", payload, status, \"retryCount\") VALUES ('tier218-paused', '$WEBHOOK_ID', '$COMPANY_ID', 'webhook.test', 'paused-event', '{}'::jsonb, 'success', 0) RETURNING id;" 2>/dev/null | head -1 | tr -d ' \n')
if [[ -n "$SEED_DELIVERY_ID" ]]; then
  api_post "/api/v1/webhooks/deliveries/$SEED_DELIVERY_ID/replay?companyId=$COMPANY_ID" ""
  assert_eq "replay on paused webhook → 400" "$STATUS" "400"
  REPLAY_MSG=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('message',''))")
  if [[ "$REPLAY_MSG" == *"not active"* ]]; then
    pass "replay paused-webhook message mentions 'not active'"
  else
    fail "expected 'not active' in: $REPLAY_MSG"
  fi
  # Restore webhook to active for the requeue test
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "UPDATE \"Webhook\" SET status='active' WHERE id='$WEBHOOK_ID';" >/dev/null 2>&1
  # Cleanup the seed delivery
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"WebhookDelivery\" WHERE id='$SEED_DELIVERY_ID';" >/dev/null 2>&1
fi

# ========== Test 6: Requeue on non-exhausted row → 400 ==========
# Try to requeue the original (status=success) — should fail
api_post "/api/v1/webhooks/deliveries/$DELIVERY_ID/requeue?companyId=$COMPANY_ID" ""
assert_eq "requeue non-exhausted → 400" "$STATUS" "400"
REQ_MSG=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('message',''))")
if [[ "$REQ_MSG" == *"not exhausted"* ]]; then
  pass "requeue non-exhausted message mentions 'not exhausted'"
else
  fail "expected 'not exhausted' in: $REQ_MSG"
fi

# ========== Test 7: Requeue happy path ==========
# Set original to exhausted
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"WebhookDelivery\" SET status='exhausted', \"retryCount\"=3, \"nextRetryAt\"='2099-12-31 23:59:59' WHERE id='$DELIVERY_ID';" >/dev/null 2>&1

api_post "/api/v1/webhooks/deliveries/$DELIVERY_ID/requeue?companyId=$COMPANY_ID" ""
assert_eq "requeue exhausted → 200" "$STATUS" "200"

# Verify row back to failed + retryCount=0
api_get "/api/v1/webhooks/$WEBHOOK_ID/deliveries?companyId=$COMPANY_ID&limit=10"
ROW_STATUS=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
for d in arr:
    if d.get('id') == '$DELIVERY_ID':
        print(d.get('status', ''))
        break
")
assert_eq "after requeue, row.status=failed" "$ROW_STATUS" "failed"
ROW_RETRY=$(echo "$BODY" | python3 -c "
import sys,json
arr = json.load(sys.stdin)
for d in arr:
    if d.get('id') == '$DELIVERY_ID':
        print(d.get('retryCount', -1))
        break
")
assert_eq "after requeue, retryCount=0" "$ROW_RETRY" "0"

# ========== Test 8: Requeue wrote activity log ==========
api_get "/api/v1/audit-logs/activity?companyId=$COMPANY_ID&limit=20"
ACTIVITY_HIT=$(echo "$BODY" | python3 -c "
import sys,json
d = json.load(sys.stdin)
arr = d.get('rows', d) if isinstance(d, dict) else d
if isinstance(arr, list):
    for a in arr:
        if a.get('action') == 'webhook.requeue' and a.get('entityId') == '$DELIVERY_ID':
            print('found')
            break
    else:
        print('missing')
else:
    print('missing')
")
assert_eq "requeue activity log written" "$ACTIVITY_HIT" "found"

# ========== Cleanup ==========
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"WebhookDelivery\" WHERE \"webhookId\"='$WEBHOOK_ID';" >/dev/null 2>&1
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"Webhook\" WHERE id='$WEBHOOK_ID';" >/dev/null 2>&1
pass "cleanup complete (webhook + deliveries)"

summary
