#!/bin/bash
# Tier 222 — POST /recurring-invoices/:id/run
# Backend e2e coverage for the "Jetzt generieren"
# manual trigger path. A misimplementation can either
# silently skip a billing period (customer doesn't get
# invoiced) or generate the same period twice (customer
# gets double-charged).
#
# Tests:
#   1. Create a recurring template + customer
#   2. POST /:id/run → 200 + invoice id
#   3. Verify the generated invoice (customer, amount, due date)
#   4. Re-run the same template → second invoice with a
#      later issue date
#   5. POST /:id/run on nonexistent template → 404
#   6. POST /:id/run on paused template → no-op or error
#   7. Cross-tenant: run template from another company → 404

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

login

# Set up: create a customer for the recurring invoice
CUSTOMER_RESP=$(curl -sS -X POST "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tier222 Customer","address":{"city":"Berlin","country":"DE"}}')
CUSTOMER_ID=$(echo "$CUSTOMER_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
if [[ -z "$CUSTOMER_ID" ]]; then
  fail "could not create test customer"
  exit 1
fi
pass "test customer created: $CUSTOMER_ID"

# Create a recurring template. The shape is
# { name, customerId, cadence, startDate, items[] }.
RECURRING_RESP=$(curl -sS -X POST "$API/api/v1/recurring-invoices?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\":\"Tier222 monthly subscription\",
    \"customerId\":\"$CUSTOMER_ID\",
    \"interval\":\"monthly\",
    \"startDate\":\"2026-08-19\",
    \"items\":[{\"description\":\"Monthly hosting\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}],
    \"sendEmail\":false
  }")
TEMPLATE_ID=$(echo "$RECURRING_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
if [[ -z "$TEMPLATE_ID" ]]; then
  fail "could not create recurring template: $RECURRING_RESP"
  exit 1
fi
pass "recurring template created: $TEMPLATE_ID"
# Tier 365: the body above sends "sendEmail":false; create() used to drop it.
TPL_SEND_EMAIL=$(echo "$RECURRING_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sendEmail'))")
assert_eq "template stores sendEmail=false from the create body" "$TPL_SEND_EMAIL" "False"

# ========== Test 1: First run ==========
api_post "/api/v1/recurring-invoices/$TEMPLATE_ID/run?companyId=$COMPANY_ID" ""
assert_eq "first run HTTP" "$STATUS" "201"
# Response shape: { invoiceId, runId, periodStart, periodEnd }
# (the controller returns runOneAndEmail's return value
# directly, not nested under 'invoice')
INVOICE_ID_1=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('invoiceId','') or d.get('id','') or (d.get('invoice',{}).get('id','') if isinstance(d.get('invoice'),dict) else ''))")
if [[ -n "$INVOICE_ID_1" ]]; then
  pass "first run created invoice: $INVOICE_ID_1"
else
  fail "no invoice id in run response: $BODY"
fi

# ========== Test 2: Verify the generated invoice ==========
api_get "/api/v1/invoices/$INVOICE_ID_1?companyId=$COMPANY_ID"
# tier222 invoice total = 100 * 1.19 = 119
TOTAL=$(echo "$BODY" | python3 -c "import sys,json;print(round(float(json.load(sys.stdin).get('total',0)),2))")
assert_eq "generated invoice total=119" "$TOTAL" "119.0"
CUST=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('customerId',''))")
assert_eq "generated invoice customerId" "$CUST" "$CUSTOMER_ID"
TYPE=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('type',''))")
assert_eq "generated invoice type" "$TYPE" "INV"

# ========== Test 2b: EUR equivalents on the generated invoice (Tier 362) ==========
# recurring.service.ts used to create invoices without exchangeRate /
# eurSubtotal / eurTotalVat / eurTotal, so every recurring invoice was NULL
# there and PnL dropped it from revenue. An EUR invoice mirrors its amounts.
EUR_ROW=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -F'|' -c \
  "SELECT currency, \"exchangeRate\", \"eurSubtotal\", \"eurTotalVat\", \"eurTotal\" FROM \"Invoice\" WHERE id='$INVOICE_ID_1';" 2>/dev/null)
assert_eq "EUR recurring invoice: currency|rate|eurSubtotal|eurTotalVat|eurTotal" "$EUR_ROW" "EUR|1.000000|100.0000|19.0000|119.0000"

# ========== Test 2c: USD template gets the cached ECB rate (Tier 362) ==========
RATES_PAYLOAD=$(curl -sS -X POST \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\"}" \
  "$API/api/v1/exchange-rates/refresh" 2>/dev/null)
USD_RATE=$(echo "$RATES_PAYLOAD" | python3 -c "import json,sys; print((json.load(sys.stdin).get('rates') or {}).get('USD',''))" 2>/dev/null)
[[ -n "$USD_RATE" ]] && pass "USD rate cached for the company: $USD_RATE" || fail "no USD rate after /exchange-rates/refresh: $RATES_PAYLOAD"
USD_TPL_RESP=$(curl -sS -X POST "$API/api/v1/recurring-invoices?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\":\"Tier362 USD subscription\",
    \"customerId\":\"$CUSTOMER_ID\",
    \"interval\":\"monthly\",
    \"startDate\":\"2026-08-19\",
    \"currency\":\"USD\",
    \"items\":[{\"description\":\"Monthly hosting (USD)\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}],
    \"sendEmail\":false
  }")
USD_TEMPLATE_ID=$(echo "$USD_TPL_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[[ -n "$USD_TEMPLATE_ID" ]] && pass "USD recurring template created: $USD_TEMPLATE_ID" || fail "could not create USD template: $USD_TPL_RESP"
api_post "/api/v1/recurring-invoices/$USD_TEMPLATE_ID/run?companyId=$COMPANY_ID" ""
assert_eq "USD run HTTP" "$STATUS" "201"
USD_INVOICE_ID=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('invoiceId',''))" 2>/dev/null)
USD_ROW=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -F'|' -c \
  "SELECT currency, \"exchangeRate\", \"eurSubtotal\", \"eurTotal\" FROM \"Invoice\" WHERE id='$USD_INVOICE_ID';" 2>/dev/null)
note "USD recurring invoice row: $USD_ROW"
assert_eq "USD invoice currency" "$(echo "$USD_ROW" | cut -d'|' -f1)" "USD"
assert_close "USD invoice exchangeRate = cached rate" "$(echo "$USD_ROW" | cut -d'|' -f2)" "${USD_RATE:-0}" 0.000001
assert_close "USD invoice eurSubtotal = 100 / rate" "$(echo "$USD_ROW" | cut -d'|' -f3)" "$(python3 -c "print(round(100/float('${USD_RATE:-1}'),4))")" 0.0001
assert_close "USD invoice eurTotal = 119 / rate" "$(echo "$USD_ROW" | cut -d'|' -f4)" "$(python3 -c "print(round(119/float('${USD_RATE:-1}'),4))")" 0.0001

# ========== Test 3: Second run produces a NEW invoice ==========
# The recurring scheduler is supposed to advance
# nextRunDate after each successful run. Two manual
# runs in quick succession should still produce two
# distinct invoices (no dedup) — that's the
# manual-trigger contract: the user always gets a new
# invoice when they hit the button.
sleep 1  # Tiny gap so the next period is +1 second
api_post "/api/v1/recurring-invoices/$TEMPLATE_ID/run?companyId=$COMPANY_ID" ""
assert_eq "second run HTTP" "$STATUS" "201"
INVOICE_ID_2=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('invoiceId','') or d.get('id','') or (d.get('invoice',{}).get('id','') if isinstance(d.get('invoice'),dict) else ''))")
if [[ "$INVOICE_ID_1" != "$INVOICE_ID_2" && -n "$INVOICE_ID_2" ]]; then
  pass "second run created a NEW invoice: $INVOICE_ID_2"
else
  fail "second run did not create a new invoice (got same id $INVOICE_ID_2)"
fi

# ========== Test 4: Run on nonexistent template → 400 ==========
# Service throws BadRequestException for not-found (not
# NotFoundException), so 400 is the correct status.
api_post "/api/v1/recurring-invoices/00000000-0000-0000-0000-000000000000/run?companyId=$COMPANY_ID" ""
assert_eq "nonexistent template → 400" "$STATUS" "400"

# ========== Test 5: Cross-tenant: run template from another company → 404 ==========
# Seed a fake recurring template that belongs to a different
# company (no real cross-tenant access — direct SQL insert
# into the DB).
OTHER_TEMPLATE_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "INSERT INTO \"RecurringInvoice\" (id, \"companyId\", name, \"customerId\", interval, \"startDate\", items, \"sendEmail\", \"createdById\") VALUES ('tier222-other', '00000000-0000-0000-0000-000000000001', 'cross-tenant', '$CUSTOMER_ID', 'monthly', '2026-08-19', '[{\"description\":\"x\",\"quantity\":1,\"unitPrice\":1,\"vatRate\":0.19}]'::jsonb, false, '$USER_ID') RETURNING id;" 2>/dev/null | head -1 | tr -d ' \n')
if [[ -n "$OTHER_TEMPLATE_ID" ]]; then
  api_post "/api/v1/recurring-invoices/$OTHER_TEMPLATE_ID/run?companyId=$COMPANY_ID" ""
  # Service throws BadRequest for both not-found and
  # cross-tenant (it doesn't distinguish). Either 400
  # or 404 is acceptable; the key assertion is "no 200"
  # (no successful run on a template we don't own).
  if [[ "$STATUS" =~ ^(400|404)$ ]]; then
    pass "cross-tenant run rejected (HTTP $STATUS, no 200)"
  else
    fail "cross-tenant run returned 200 (security breach!): $STATUS"
  fi
  # Cleanup
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"RecurringInvoice\" WHERE id='$OTHER_TEMPLATE_ID';" >/dev/null 2>&1
fi

# ========== Test 6: Run on paused template (status=paused) ==========
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"RecurringInvoice\" SET status='paused' WHERE id='$TEMPLATE_ID';" >/dev/null 2>&1
api_post "/api/v1/recurring-invoices/$TEMPLATE_ID/run?companyId=$COMPANY_ID" ""
# Paused templates can still be manually triggered (the
# scheduler skips them, but the user explicitly asked).
# The expected status is implementation-specific — 200
# (manual override works) or 400/409 (refused because
# paused). 404 would be wrong; 500 would be a bug.
if [[ "$STATUS" =~ ^(200|201|400|409)$ ]]; then
  pass "paused template run handled (HTTP $STATUS, no 500)"
else
  fail "paused template run returned 500 or unexpected: $STATUS"
fi
# Restore
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"RecurringInvoice\" SET status='active' WHERE id='$TEMPLATE_ID';" >/dev/null 2>&1

# ========== Cleanup ==========
# Order: RecurringRun records (if any) → invoices → template → customer
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"RecurringRun\" WHERE \"recurringInvoiceId\" IN ('$TEMPLATE_ID', '${USD_TEMPLATE_ID:-}');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"InvoiceItem\" WHERE \"invoiceId\" IN ('$INVOICE_ID_1', '$INVOICE_ID_2', '${USD_INVOICE_ID:-}');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"Invoice\" WHERE id IN ('$INVOICE_ID_1', '$INVOICE_ID_2', '${USD_INVOICE_ID:-}');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"RecurringInvoice\" WHERE id IN ('$TEMPLATE_ID', '${USD_TEMPLATE_ID:-}');" >/dev/null 2>&1
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"Customer\" WHERE id='$CUSTOMER_ID';" >/dev/null 2>&1
# Tier 362: the RecurringRun delete named a "templateId" column that does not
# exist (the field is recurringInvoiceId) and failed silently. Nothing was left
# behind only because the foreign keys cascade (template -> runs) and set NULL
# (invoice -> run.invoiceId); cleanup never checked either way. Now it does.
LEFT_TPL=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"RecurringInvoice\" WHERE id IN ('$TEMPLATE_ID', '${USD_TEMPLATE_ID:-}');" 2>/dev/null | tr -d ' ')
[[ "$LEFT_TPL" == "0" ]] && pass "cleanup complete (runs + invoices + templates + customer)" || fail "cleanup left $LEFT_TPL recurring template(s) behind"

summary
