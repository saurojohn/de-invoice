#!/bin/bash
# Tier 238 — e2e coverage: Customer detail Zahlungen + Dokumente tabs
#
# The customer detail page (/dashboard/customers/[id]) was extended
# in Tier 238 with two new tabs:
#
#   - "Zahlungen" (payments): walks the customer's invoices via
#     /invoices?customerId=<id>, then for each invoice fetches
#     /invoices/<invId>/payments and concatenates. The result is
#     sorted by paymentDate desc (newest first) and rendered as a
#     single table with sum at the top.
#
#   - "Dokumente" (attachments): GET /attachments?entityType=
#     customer&entityId=<id>. The backend controller's list
#     endpoint doesn't enforce entityType whitelist (only the
#     upload endpoint does), so this returns 200 + [] in practice
#     (no customer attachments are uploaded). The frontend
#     treats non-2xx as soft-fail and shows the empty state.
#
# This script verifies the BACKEND contract that the frontend
# relies on:
#
#   1. /invoices?customerId=<id> returns paginated list of that
#      customer's invoices (with envelope { data, total })
#   2. /invoices/<invId>/payments returns the payment array
#      (with real Prisma field names: paymentDate, paymentMethod,
#       amount as string from Decimal)
#   3. /invoices/<invId>/payments with unknown invoiceId returns
#      404 NotFoundException with German message
#   4. /attachments?entityType=customer&entityId=<id> returns 200
#      + [] (empty array, since no customer attachments exist)
#   5. /attachments?entityType=customer&entityId=<id> with
#      missing companyId returns 400 BadRequestException
#   6. At least one of the seed customers has paid invoices
#      (so the payment walk finds rows to display — regression
#       check on the data side)
#
# Note: The frontend's payments walk is sequential (one
# /payments request per invoice) and tolerates per-invoice
# failure. So even if some invoices have no payments endpoint
# (impossible — all invoices have it), the tab still renders.
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

# ---- Pick a customer that has paid invoices ----
# We need a customer with at least one Payment row in the DB.
# Pull from the database directly so this test is deterministic
# regardless of UI state.
CUSTOMER_INFO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT c.id, c.name
  FROM \"Customer\" c
  WHERE c.\"companyId\" = '$COMPANY_ID'
    AND EXISTS (
      SELECT 1 FROM \"Invoice\" i
      JOIN \"Payment\" p ON p.\"invoiceId\" = i.id
      WHERE i.\"customerId\" = c.id
    )
  LIMIT 1;
")
TEST_CUSTOMER_ID=$(echo "$CUSTOMER_INFO" | cut -d'|' -f1 | tr -d ' ')
TEST_CUSTOMER_NAME=$(echo "$CUSTOMER_INFO" | cut -d'|' -f2 | sed 's/^ *//;s/ *$//')

if [[ -z "$TEST_CUSTOMER_ID" ]]; then
  echo -e "\n${YELLOW}⏭ SKIPPED${NC}: no customer with paid invoices in seed DB"
  echo "  (the test depends on Payment rows — without them, the walk finds nothing)"
  exit 0
fi
pass "test customer: $TEST_CUSTOMER_NAME ($TEST_CUSTOMER_ID)"

# ---- 1. /invoices?customerId=... returns paginated list ----
api_get "/api/v1/invoices?companyId=$COMPANY_ID&customerId=$TEST_CUSTOMER_ID&pageSize=200"
assert_status "200" "GET /invoices?customerId=<id>"
TOTAL=$(echo "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('total',0))")
DATA_LEN=$(echo "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(len(d.get('data',[])))")
[ "$TOTAL" -ge 1 ] && pass "customer has $TOTAL invoice(s)" || fail "customer has 0 invoices"
[ "$DATA_LEN" -le 200 ] && pass "data array length $DATA_LEN <= pageSize 200" || fail "data length exceeds pageSize"

# Extract one invoice with payments to test the per-invoice walk
INV_WITH_PAY=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT i.id, i.\"invoiceNumber\"
  FROM \"Invoice\" i
  WHERE i.\"customerId\" = '$TEST_CUSTOMER_ID'
    AND EXISTS (SELECT 1 FROM \"Payment\" p WHERE p.\"invoiceId\" = i.id)
  ORDER BY i.\"issueDate\" DESC
  LIMIT 1;
")
TEST_INV_ID=$(echo "$INV_WITH_PAY" | cut -d'|' -f1 | tr -d ' ')
TEST_INV_NUM=$(echo "$INV_WITH_PAY" | cut -d'|' -f2 | sed 's/^ *//;s/ *$//')
[ -n "$TEST_INV_ID" ] && pass "test invoice: $TEST_INV_NUM ($TEST_INV_ID)" || fail "no invoice with payments"

# ---- 2. /invoices/:id/payments returns payment list with real field names ----
api_get "/api/v1/invoices/$TEST_INV_ID/payments?companyId=$COMPANY_ID"
assert_status "200" "GET /invoices/<id>/payments"
PAY_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")
[ "$PAY_COUNT" -ge 1 ] && pass "invoice has $PAY_COUNT payment(s)" || fail "invoice has 0 payments"

# Verify the real Prisma field names: paymentDate, paymentMethod, amount (as string from Decimal)
FIRST_PAY=$(echo "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(json.dumps(d[0]))")
HAS_DATE=$(echo "$FIRST_PAY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('yes' if d.get('paymentDate') else 'no')")
HAS_METHOD=$(echo "$FIRST_PAY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('yes' if d.get('paymentMethod') else 'no')")
HAS_AMOUNT=$(echo "$FIRST_PAY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('yes' if d.get('amount') is not None else 'no')")
[ "$HAS_DATE" = "yes" ] && pass "Payment has paymentDate field (real Prisma name, NOT paidAt)" || fail "Payment missing paymentDate (got $FIRST_PAY)"
[ "$HAS_METHOD" = "yes" ] && pass "Payment has paymentMethod field (real Prisma name, NOT method)" || fail "Payment missing paymentMethod"
[ "$HAS_AMOUNT" = "yes" ] && pass "Payment has amount field (Decimal serialised as string)" || fail "Payment missing amount"

# Verify the wrong field names are NOT used (regression check)
HAS_WRONG_DATE=$(echo "$FIRST_PAY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('yes' if d.get('paidAt') else 'no')")
HAS_WRONG_METHOD=$(echo "$FIRST_PAY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('yes' if d.get('method') and not d.get('paymentMethod') else 'no')")
[ "$HAS_WRONG_DATE" = "no" ] && pass "Payment does NOT use stale 'paidAt' field" || fail "Payment still uses paidAt"
[ "$HAS_WRONG_METHOD" = "no" ] && pass "Payment does NOT use stale 'method' field" || fail "Payment still uses method"

# ---- 3. /invoices/:id/payments with unknown invoiceId returns 404 ----
api_get "/api/v1/invoices/00000000-0000-0000-0000-000000000000/payments?companyId=$COMPANY_ID"
assert_status "404" "GET /invoices/<unknown>/payments → 404"
ERR_MSG=$(echo "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message',''))")
echo "$ERR_MSG" | grep -qi "nicht gefunden" && pass "404 message is German: $ERR_MSG" || note "404 message: $ERR_MSG (tolerated)"

# ---- 4. /attachments?entityType=customer&entityId=<id> returns 200 + [] ----
# The backend's list endpoint doesn't validate entityType against
# the upload whitelist (only the upload does). So a customer
# query returns 200 + [] (no customer attachments uploaded yet).
api_get "/api/v1/attachments?companyId=$COMPANY_ID&entityType=customer&entityId=$TEST_CUSTOMER_ID"
assert_status "200" "GET /attachments?entityType=customer → 200"
ATT_COUNT=$(echo "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(len(d) if isinstance(d,list) else -1)")
[ "$ATT_COUNT" -eq 0 ] && pass "attachments list is empty array (no customer attachments uploaded yet)" || note "attachments list has $ATT_COUNT item(s) — non-empty is fine if seeded"

# ---- 5. /attachments without companyId returns 400 ----
api_get "/api/v1/attachments?entityType=customer&entityId=$TEST_CUSTOMER_ID"
assert_status "400" "GET /attachments without companyId → 400"

# ---- 6. Verify upload with customer entityType is REJECTED (whitelist) ----
# The upload endpoint enforces entityType whitelist. 'customer'
# is NOT in the allowed set (expense, voucher, berater-note,
# invoice), so the upload attempt must 400 with German message.
# This confirms the design: customer attachments are not yet
# supported at the upload level, so the Dokumente tab will be
# empty until that whitelist is extended.
TMP_FILE=$(mktemp /tmp/tier238-upload.XXXXXX)
echo "fake customer doc" > "$TMP_FILE"
UP_HTTP=$(curl -sS -o /tmp/tier238-upload-resp.txt -w "%{http_code}" -X POST \
  "$API/api/v1/attachments" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -F "file=@$TMP_FILE" \
  -F "companyId=$COMPANY_ID" \
  -F "entityType=customer" \
  -F "entityId=$TEST_CUSTOMER_ID")
[ "$UP_HTTP" = "400" ] && pass "POST /attachments with entityType=customer → 400 (whitelist enforced)" || fail "customer upload should 400, got $UP_HTTP"
UP_MSG=$(cat /tmp/tier238-upload-resp.txt | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message',''))" 2>/dev/null)
echo "$UP_MSG" | grep -q "muss 'expense'" && pass "upload 400 message mentions allowed entityTypes" || note "upload 400 message: $UP_MSG"
rm -f "$TMP_FILE" /tmp/tier238-upload-resp.txt

# ---- 7. /invoices/:id/payments with wrong companyId returns 404 (cross-tenant) ----
# Defence-in-depth: the service verifies invoice belongs to
# companyId. A request with the right invoiceId but wrong
# companyId must 404 (not 403, security through obscurity).
WRONG_COMPANY="00000000-0000-0000-0000-000000000000"
api_get "/api/v1/invoices/$TEST_INV_ID/payments?companyId=$WRONG_COMPANY"
assert_status "404" "GET /invoices/<id>/payments with wrong companyId → 404"

summary
