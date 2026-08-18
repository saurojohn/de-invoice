#!/bin/bash
# Tier 8: Recurring invoice wizard backend coverage.
# Verifies the full CRUD + preview + run cycle
# via the API. The UI modal already exists at
# /dashboard/recurring-invoices and reads from
# the same endpoints, so a green backend covers
# the e2e surface for this tier.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 8 Recurring invoice CRUD + preview + run ==="
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"RecurringRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"RecurringInvoice\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'E2E-REC-%';" >/dev/null 2>&1

CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')

# ===== 1. Create template =====
api_post "/api/v1/recurring-invoices?companyId=$COMPANY_ID" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"E2E Wartung 2026\",\"customerId\":\"$CUST_ID\",\"interval\":\"monthly\",\"intervalCount\":1,\"dayOfMonth\":15,\"startDate\":\"2026-06-01\",\"invoiceStatus\":\"draft\",\"items\":[{\"description\":\"Wartung Standard\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":100,\"vatRate\":0.19}],\"notes\":\"automatisch generiert\"}"
assert_status 201 "1. create recurring template (201)"
TPL_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
NAME=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
assert_eq "1b. name persisted" "$NAME" "E2E Wartung 2026"

# ===== 2. List =====
api_get "/api/v1/recurring-invoices?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "2. list shows 1 template" "$COUNT" "1"

# ===== 3. Get one =====
api_get "/api/v1/recurring-invoices/$TPL_ID?companyId=$COMPANY_ID"
INTERVAL=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['interval'])")
assert_eq "3. interval = monthly" "$INTERVAL" "monthly"

# ===== 4. Preview next run =====
api_get "/api/v1/recurring-invoices/$TPL_ID/preview?companyId=$COMPANY_ID"
assert_status 200 "4. preview returns 200"
NEXT=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('nextRun', d.get('periodStart', '')))" 2>/dev/null)
if [[ -n "$NEXT" ]]; then
  pass "4b. preview has nextRun = $NEXT"
else
  fail "4b. preview missing nextRun field"
fi

# ===== 5. Update =====
api_put "/api/v1/recurring-invoices/$TPL_ID?companyId=$COMPANY_ID" "{\"name\":\"E2E Wartung 2026 (updated)\",\"interval\":\"quarterly\",\"intervalCount\":1,\"dayOfMonth\":15,\"invoiceStatus\":\"sent\"}"
assert_status 200 "5. update template (200)"
NEW_INTERVAL=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['interval'])")
assert_eq "5b. interval updated to quarterly" "$NEW_INTERVAL" "quarterly"

# ===== 6. Run now =====
api_post "/api/v1/recurring-invoices/$TPL_ID/run?companyId=$COMPANY_ID" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "6. run-now (201)"
INVOICE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('invoiceId', ''))" 2>/dev/null)
if [[ -n "$INVOICE_ID" ]]; then
  pass "6b. run produced invoice $INVOICE_ID"
else
  fail "6b. no invoiceId in response"
fi

# ===== 7. Verify the generated invoice =====
INV_NO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE id = '$INVOICE_ID';" 2>/dev/null | tr -d ' ')
if [[ -n "$INV_NO" ]]; then
  pass "7. generated invoice exists with number $INV_NO"
else
  fail "7. no invoice found with id $INVOICE_ID"
fi

# Verify it has the right line items
LINE_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"InvoiceItem\" WHERE \"invoiceId\" = '$INVOICE_ID';" 2>/dev/null | tr -d ' ')
assert_eq "7b. invoice has 1 line item" "$LINE_COUNT" "1"

# ===== 8. Toggle isActive =====
api_put "/api/v1/recurring-invoices/$TPL_ID?companyId=$COMPANY_ID" "{\"isActive\":false}"
assert_status 200 "8. deactivate (200)"
ACTIVE=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['isActive'])")
assert_eq "8b. isActive = false" "$ACTIVE" "False"

# ===== 9. Delete =====
api_delete "/api/v1/recurring-invoices/$TPL_ID?companyId=$COMPANY_ID"
assert_status 200 "9. delete (200)"

api_get "/api/v1/recurring-invoices?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "9b. list empty after delete" "$COUNT" "0"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"RecurringRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"RecurringInvoice\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"InvoiceItem\" WHERE \"invoiceId\" = '$INVOICE_ID';
  DELETE FROM \"Invoice\" WHERE id = '$INVOICE_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
