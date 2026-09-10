#!/usr/bin/env bash
# e2e 63: Tier 33 — Customer self-service portal (Kundenportal).
#
# Validates the full flow:
#   1. POST /invoices/:id/generate-payment-link
#      → 201, returns {token, url, expiresAt, reused}
#   2. Same call again → reused=true (idempotency).
#   3. GET /portal/:token (no auth) → invoice +
#      company summary.
#   4. GET /portal/<bad-token> → 404.
#   5. POST /portal/:token/mark-paid → 201,
#      creates Payment row, sets usedAt.
#   6. Same mark-paid again → alreadyPaid=true.
#   7. POST /invoices/:id/revoke-payment-links
#      → 201, revokes all active links.
#   8. GET /portal/<revoked token> → 404.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# Cleanup PaymentLink rows + their dependent
# Payment rows for any previous run.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"PaymentLink\" WHERE \"invoiceId\" IN (
    SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID'
  );
  DELETE FROM \"Payment\" WHERE \"paymentMethod\" = 'portal-mock' AND \"invoiceId\" IN (
    SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID'
  );" >/dev/null 2>&1

# Get the first draft invoice.
LIST=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices?companyId=$COMPANY_ID&status=draft")
INV_ID=$(echo "$LIST" | python3 -c "
import json,sys
d = json.load(sys.stdin)
items = d if isinstance(d, list) else d.get('items', d.get('data', []))
print(items[0]['id'] if items else '')")
if [[ -z "$INV_ID" ]]; then
  fail "no draft invoice to test with"
  exit 1
fi
note "Using invoice $INV_ID"

# ---- 1. Generate link ----
echo
echo "=== 1. POST /invoices/:id/generate-payment-link (first time) ==="
api_post "/api/v1/invoices/$INV_ID/generate-payment-link?companyId=$COMPANY_ID" '{"origin":"http://localhost:3100"}'
assert_status "201" "generate link"
TOKEN=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
URL=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
REUSED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['reused'])")
assert_eq "token length" "${#TOKEN}" "32"
if [[ "$URL" == *"http://localhost:3100/pay/$TOKEN" ]]; then
  pass "URL has /pay/\$TOKEN shape"
else
  fail "URL shape: $URL"
fi
assert_eq "first-time reused=false" "$REUSED" "False"

# ---- 2. Generate again — idempotent ----
echo
echo "=== 2. POST /generate-payment-link (second time, same invoice) ==="
api_post "/api/v1/invoices/$INV_ID/generate-payment-link?companyId=$COMPANY_ID" '{}'
assert_status "201" "regenerate link returns 201"
TOKEN2=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
REUSED2=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['reused'])")
assert_eq "token matches (idempotent)" "$TOKEN2" "$TOKEN"
assert_eq "second call reused=true" "$REUSED2" "True"

# ---- 3. GET /portal/:token (no auth) ----
echo
echo "=== 3. GET /portal/:token (public, no auth) ==="
STATUS=$(curl -sS -o /tmp/t63_view.json -w "%{http_code}" \
  "$API/api/v1/portal/$TOKEN")
assert_status_view() {
  if [[ "$STATUS" == "$1" ]]; then pass "$2 (HTTP $STATUS)"; else fail "$2 (expected $1, got $STATUS)"; fi
}
assert_status_view "200" "public view returns 200"
INVOICE_NUM=$(jq -r '.invoice.invoiceNumber' /tmp/t63_view.json)
COMPANY_NAME=$(jq -r '.company.name' /tmp/t63_view.json)
assert_eq "public view: invoiceNumber" "$INVOICE_NUM" "$(echo "$LIST" | python3 -c "import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get('items',d.get('data',[])); print(items[0]['invoiceNumber'])")"
if [[ -n "$COMPANY_NAME" && "$COMPANY_NAME" != "null" ]]; then
  pass "public view: company.name = $COMPANY_NAME"
else
  fail "company.name missing"
fi

# ---- 4. Bad token → 404 ----
echo
echo "=== 4. GET /portal/<bad-token> → 404 ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/portal/bad-token-does-not-exist-1234")
assert_status_view "404" "bad token returns 404"

# ---- 5. POST /portal/:token/mark-paid ----
echo
echo "=== 5. POST /portal/:token/mark-paid (first time) ==="
api_post "/api/v1/portal/$TOKEN/mark-paid" '{}'
assert_status "201" "mark-paid returns 201"
ALREADY=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['alreadyPaid'])")
PAYMENT_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('paymentId',''))")
assert_eq "alreadyPaid=false (first time)" "$ALREADY" "False"
if [[ -n "$PAYMENT_ID" ]]; then pass "Payment row created (id=$PAYMENT_ID)"; else fail "no Payment id"; fi

# Verify a Payment row actually exists in DB.
P_COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT COUNT(*) FROM \"Payment\" WHERE \"invoiceId\" = '$INV_ID' AND \"paymentMethod\" = 'portal-mock';" 2>/dev/null | tr -d ' ')
if [[ "$P_COUNT" == "1" ]]; then
  pass "Payment row persisted (count=1)"
else
  fail "Payment row count=$P_COUNT (expected 1)"
fi

# ---- 6. mark-paid again (idempotent) ----
echo
echo "=== 6. POST /portal/:token/mark-paid (already used) ==="
api_post "/api/v1/portal/$TOKEN/mark-paid" '{}'
assert_status "201" "mark-paid again returns 201"
ALREADY2=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['alreadyPaid'])")
assert_eq "alreadyPaid=true (second time)" "$ALREADY2" "True"

# ---- 7. After mark-paid, link is consumed → view 404 ----
echo
echo "=== 7. GET /portal/<used-token> → 404 (link consumed) ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/portal/$TOKEN")
assert_status_view "404" "used link returns 404"

# ---- 8. Generate fresh + revoke ----
echo
echo "=== 8. POST /revoke-payment-links ==="
# First reset the invoice to draft (markPaid above may
# have bumped status='paid').
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Invoice\" SET status='draft' WHERE id = '$INV_ID';
" >/dev/null 2>&1
# Generate fresh link (idempotency returns the consumed one
# because usedAt is set — rotate by creating a new token
# via SQL bypass).
NEW_TOKEN=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  INSERT INTO \"PaymentLink\"(id, \"invoiceId\", token, \"expiresAt\", \"createdAt\")
  VALUES (gen_random_uuid()::text, '$INV_ID', 'revokeme1234567890abcdef01234567', NOW() + interval '30 days', NOW())
  RETURNING token;" 2>/dev/null | tr -d ' \r\n')
if [[ -z "$NEW_TOKEN" ]]; then
  fail "could not insert fresh token for revoke test"
else
  api_post "/api/v1/invoices/$INV_ID/revoke-payment-links?companyId=$COMPANY_ID" '{}'
  assert_status "201" "revoke returns 201"
  REVOKED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['revoked'])")
  if [[ "$REVOKED" -ge "1" ]]; then
    pass "revoked=$REVOKED links (>=1)"
  else
    fail "revoked=$REVOKED"
  fi
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/portal/$NEW_TOKEN")
  assert_status_view "404" "revoked token returns 404"
fi

# ---- Cleanup ----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE \"invoiceId\" = '$INV_ID' AND \"paymentMethod\" = 'portal-mock';
  DELETE FROM \"PaymentLink\" WHERE \"invoiceId\" = '$INV_ID';
  UPDATE \"Invoice\" SET status='draft' WHERE id = '$INV_ID';" >/dev/null 2>&1
mavis-trash /tmp/t63_view.json 2>/dev/null

if [[ $FAILS -gt 0 ]]; then
  echo
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
echo "ALL PASSED"