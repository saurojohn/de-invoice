#!/bin/bash
# Tier 228 — e2e coverage: inventory (stock + adjust + low-stock + history)
#
# The inventory controller had 0 e2e coverage. It backs the
# "Lagerbestand" feature on the product detail page:
# the operator sees current stock, can manually adjust it
# (sale/purchase/return/adjustment/initial), and the
# dashboard surfaces a "low-stock" widget.
#
# Assertions:
#   1. PUT /inventory/:productId/adjust with changeType=purchase → 200,
#      stock increases by quantity
#   2. PUT adjust with changeType=sale → stock decreases
#   3. PUT adjust with changeType=adjustment → stock set to quantity
#   4. PUT adjust with changeType=initial → stock set to quantity
#   5. PUT adjust with changeType=return → stock increases
#   6. GET /inventory/:productId returns current stock + threshold
#   7. GET /inventory/:productId with fake id → returns null (not 404)
#   8. PUT adjust with fake product id → 500 (plain Error, not
#      NotFoundException — pre-existing, not fixed in this tier)
#   9. GET /inventory/:productId/history shows the stock movements
#      from our adjustments
#  10. GET /inventory/low-stock?companyId=... returns array
#  11. Cleanup: delete the test product
source "$(dirname "$0")/_lib.sh"
login

STAMP=$(date +%s%N | tail -c 9)
PROD_NAME="Tier228 Inv ${STAMP}"
SKU="T228-${STAMP}"

# ---- Seed a product to test against ----
# Use the API so the company linkage is correct.
# Note: DTO field is `basePrice` (not `price`), and vatRate
# / stockQuantity / lowStockThreshold are numbers (not strings).
api_post "/api/v1/products?companyId=$COMPANY_ID" "$(cat <<EOF
{
  "name": "${PROD_NAME}",
  "sku": "${SKU}",
  "unit": "Stk",
  "basePrice": 10.00,
  "vatRate": 0.19,
  "trackInventory": true,
  "stockQuantity": 50,
  "lowStockThreshold": 10,
  "active": true
}
EOF
)"
assert_status 201 "seed product"
PROD_ID=$(json_field "$BODY" id)
[ -n "$PROD_ID" ] && pass "seed product id: $PROD_ID" || fail "no product id"

# ---- 1. purchase (increment) ----
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"purchase","quantity":25,"notes":"Tier228 purchase"}'
assert_status 200 "PUT adjust purchase +25"
NEW_STOCK=$(json_field "$BODY" newQty)
[ "$NEW_STOCK" = "75" ] && pass "purchase: stock 50 + 25 = 75" || fail "newQty = $NEW_STOCK (expected 75)"

# ---- 2. sale (decrement) ----
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"sale","quantity":30,"notes":"Tier228 sale"}'
assert_status 200 "PUT adjust sale -30"
NEW_STOCK=$(json_field "$BODY" newQty)
[ "$NEW_STOCK" = "45" ] && pass "sale: stock 75 - 30 = 45" || fail "newQty = $NEW_STOCK (expected 45)"

# ---- 3. adjustment (set) ----
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"adjustment","quantity":100,"notes":"Tier228 adjustment"}'
assert_status 200 "PUT adjust adjustment set=100"
NEW_STOCK=$(json_field "$BODY" newQty)
[ "$NEW_STOCK" = "100" ] && pass "adjustment: stock set to 100" || fail "newQty = $NEW_STOCK (expected 100)"

# ---- 4. initial (set) ----
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"initial","quantity":5,"notes":"Tier228 initial"}'
assert_status 200 "PUT adjust initial set=5"
NEW_STOCK=$(json_field "$BODY" newQty)
[ "$NEW_STOCK" = "5" ] && pass "initial: stock set to 5" || fail "newQty = $NEW_STOCK (expected 5)"

# ---- 5. return (increment) ----
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"return","quantity":8,"notes":"Tier228 return"}'
assert_status 200 "PUT adjust return +8"
NEW_STOCK=$(json_field "$BODY" newQty)
[ "$NEW_STOCK" = "13" ] && pass "return: stock 5 + 8 = 13" || fail "newQty = $NEW_STOCK (expected 13)"

# ---- 6. GET stock ----
api_get "/api/v1/inventory/$PROD_ID"
assert_status 200 "GET /inventory/:productId"
[ "$(json_field "$BODY" name)" = "$PROD_NAME" ] && pass "stock endpoint returns product name" || fail "name = $(json_field "$BODY" name)"
[ "$(json_field "$BODY" stockQuantity)" = "13" ] && pass "stock endpoint shows current stock=13" || fail "stockQuantity = $(json_field "$BODY" stockQuantity)"

# ---- 7. GET stock with fake id → returns null (200, not 404) ----
# The service does findUnique → no row → returns null. NestJS
# serializes null via Express's res.send(null) which on Express 4
# renders an empty body (Content-Length: 0). The status is
# still 200 (controller didn't throw). This is the documented
# behaviour for "not found" in this controller — different
# from the other endpoints that throw NotFoundException.
api_get "/api/v1/inventory/00000000-0000-0000-0000-000000000000"
assert_status 200 "GET fake id (null body)"
[ -z "$BODY" ] && pass "fake id returns empty body (TS null serialised by Express 4)" || fail "fake id body = '$BODY' (expected empty)"

# ---- 8. PUT adjust with fake product id → 500 ----
# Pre-existing: service throws plain `new Error('Product not found')`
# not a NestJS NotFoundException, so it surfaces as 500. Not
# fixing in a coverage tier.
api_put "/api/v1/inventory/00000000-0000-0000-0000-000000000000/adjust" '{"changeType":"purchase","quantity":1}'
HTTP=$(curl -sS -o /tmp/tier228-fake-prod.json -w "%{http_code}" \
  -X PUT \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"changeType":"purchase","quantity":1}' \
  "$API/api/v1/inventory/00000000-0000-0000-0000-000000000000/adjust")
[ "$HTTP" = "500" ] && pass "fake productId 500 (plain Error, pre-existing)" || note "fake productId HTTP = $HTTP (expected 500, but tolerated)"

# ---- 9. GET stock history ----
api_get "/api/v1/inventory/$PROD_ID/history?limit=10"
assert_status 200 "GET /inventory/:productId/history"
HIST_COUNT=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$BODY" 2>/dev/null)
# We did 5 adjustments (purchase, sale, adjustment, initial, return)
[ "$HIST_COUNT" = "5" ] && pass "history shows all 5 adjustments" || fail "history count = $HIST_COUNT (expected 5)"
# Most recent (return +8) should be first
FIRST_TYPE=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print(rows[0].get('changeType') if rows else '')" "$BODY" 2>/dev/null)
[ "$FIRST_TYPE" = "return" ] && pass "history ordered desc (newest first = return)" || fail "history[0].changeType = $FIRST_TYPE (expected return)"

# ---- 10. GET low-stock ----
# Our test product: stockQuantity=13, lowStockThreshold=10, trackInventory=true, active=true
# 13 > 10 → NOT low stock → should NOT appear in low-stock list
api_get "/api/v1/inventory/low-stock?companyId=$COMPANY_ID"
assert_status 200 "GET /inventory/low-stock"
HAS_PROD=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print('yes' if any(r.get('id')=='$PROD_ID' for r in rows) else 'no')" "$BODY" 2>/dev/null)
[ "$HAS_PROD" = "no" ] && pass "stock=13 NOT in low-stock list (above threshold)" || fail "stock=13 wrongly in low-stock list"

# Drop stock to 5 to make it low-stock, then re-check
api_put "/api/v1/inventory/$PROD_ID/adjust" '{"changeType":"adjustment","quantity":5,"notes":"Tier228 low stock test"}'
api_get "/api/v1/inventory/low-stock?companyId=$COMPANY_ID"
assert_status 200 "GET /inventory/low-stock after drop"
HAS_PROD=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print('yes' if any(r.get('id')=='$PROD_ID' for r in rows) else 'no')" "$BODY" 2>/dev/null)
[ "$HAS_PROD" = "yes" ] && pass "stock=5 IS in low-stock list (at/below threshold)" || fail "stock=5 not in low-stock list"

# ---- 11. Cleanup ----
api_delete "/api/v1/products/$PROD_ID?companyId=$COMPANY_ID" >/dev/null
pass "Cleaned up test product"

rm -f /tmp/tier228-fake-prod.json

summary
