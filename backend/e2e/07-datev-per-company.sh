#!/bin/bash
# Test 07: Per-company DATEV account mapping.
# Verifies that the GET / PUT /api/v1/companies/:id/datev-config
# endpoints round-trip the user's account overrides, and
# that the /reports/datev-export endpoint actually uses
# the customised account numbers in the exported CSV.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: per-company DATEV account mapping ==="

# Baseline: GET returns defaults
api_get "/api/v1/companies/$COMPANY_ID/datev-config"
DEFAULT_BANK=$(json_field "$BODY" config.bank)
assert_eq "default config.bank" "$DEFAULT_BANK" "1200"
DEFAULT_REV=$(json_field "$BODY" config.revenue19)
assert_eq "default config.revenue19" "$DEFAULT_REV" "8400"

# PUT a partial override: change bank + revenue19, leave everything else
api_put "/api/v1/companies/$COMPANY_ID/datev-config" "{
  \"accounts\": { \"bank\": \"9999\", \"revenue19\": \"8888\" },
  \"beraterNr\": \"12345\",
  \"mandantenNr\": \"67890\"
}"
assert_status "200" "PUT custom DATEV config"

# GET back — bank + revenue19 changed, revenue7 stayed default
api_get "/api/v1/companies/$COMPANY_ID/datev-config"
assert_eq "config.bank after PUT" "$(json_field "$BODY" config.bank)" "9999"
assert_eq "config.revenue19 after PUT" "$(json_field "$BODY" config.revenue19)" "8888"
assert_eq "config.revenue7 (untouched)" "$(json_field "$BODY" config.revenue7)" "8300"
assert_eq "overrides.bank" "$(json_field "$BODY" overrides.bank)" "9999"

# Make sure at least one paid invoice exists so DATEV has rows
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "SELECT count(*) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND status = 'paid';" >/dev/null 2>&1
PAID_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND status = 'paid';" 2>/dev/null | tr -d ' ')

# If no paid invoices, create a quick one to test the export end-to-end
if [[ "$PAID_COUNT" == "0" ]]; then
  note "No paid invoices — creating a quick test invoice + payment"

  # Get any customer
  CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')
  if [[ -z "$CUST_ID" ]]; then
    note "No customer — creating a placeholder"
    docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "INSERT INTO \"Customer\" (id, \"companyId\", name, \"customerNumber\", \"createdAt\", \"updatedAt\")
       VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'E2E DATEV Test', 'K-E2E', now(), now());" >/dev/null 2>&1
    CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
      "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'E2E DATEV Test' LIMIT 1;" 2>/dev/null | tr -d ' ')
  fi

  api_post "/api/v1/invoices?companyId=$COMPANY_ID" "{
    \"customerId\": \"$CUST_ID\",
    \"type\": \"INV\",
    \"status\": \"paid\",
    \"issueDate\": \"2026-06-01\",
    \"dueDate\": \"2026-06-15\",
    \"currency\": \"EUR\",
    \"language\": \"de-DE\",
    \"items\": [{
      \"description\": \"E2E DATEV Test\",
      \"quantity\": 1,
      \"unit\": \"Stk\",
      \"unitPrice\": 100,
      \"vatRate\": 0.19
    }]
  }" >/dev/null

  INV_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND type = 'INV' ORDER BY \"createdAt\" DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
  INV_NO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE id = '$INV_ID';" 2>/dev/null | tr -d ' ')
  note "Created invoice $INV_NO"

  # Register a payment so the invoice is "paid" and triggers DATEV revenue
  api_post "/api/v1/invoices/$INV_ID/payments?companyId=$COMPANY_ID" "{
    \"amount\": 119.00,
    \"paymentDate\": \"2026-06-01\",
    \"method\": \"bank_transfer\",
    \"notes\": \"E2E test payment\"
  }" >/dev/null
fi

# Now fetch the DATEV export and check 9999 + 8888 are present
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" -o /tmp/datev-e2e.csv

if file_contains "9999" /tmp/datev-e2e.csv; then
  pass "Custom bank 9999 appears in DATEV export"
else
  fail "Custom bank 9999 missing from DATEV export"
fi

if file_contains "8888" /tmp/datev-e2e.csv; then
  pass "Custom revenue19 8888 appears in DATEV export"
else
  fail "Custom revenue19 8888 missing from DATEV export"
fi

# Berater-Nr in the header (column 6 of line 1)
if head -1 /tmp/datev-e2e.csv | LC_ALL=C grep -q "12345"; then
  pass "Custom Berater-Nr 12345 in header"
else
  fail "Custom Berater-Nr 12345 missing from header"
  echo "  header: $(head -1 /tmp/datev-e2e.csv | cut -c1-80)"
fi

# Default accounts (untouched) should still be present. The
# test data has no 7% VAT invoices (all are 19%) so we can't
# assert on 8300 directly — instead verify the SKR03 default
# for Vorsteuer (1576) is still used, which IS present because
# the test data has expenses.
if file_contains "1576" /tmp/datev-e2e.csv; then
  pass "Default inputVat19 1576 still in export (untouched override)"
else
  fail "Default inputVat19 1576 missing — override may have wiped defaults"
fi

# Sanitisation: invalid account number should be dropped silently
api_put "/api/v1/companies/$COMPANY_ID/datev-config" "{
  \"accounts\": { \"bank\": \"AB-CD\", \"revenue19\": \"99\" }
}"
assert_status "200" "PUT with invalid account (sanitised)"

api_get "/api/v1/companies/$COMPANY_ID/datev-config"
# The bad bank "AB-CD" should NOT be in overrides
OVER_BANK=$(json_field "$BODY" overrides.bank)
if [[ -z "$OVER_BANK" || "$OVER_BANK" == "null" ]]; then
  pass "Invalid bank 'AB-CD' rejected by sanitizer"
else
  fail "Invalid bank 'AB-CD' should be rejected, got: $OVER_BANK"
fi
# '99' is 2 digits, below the 3-5 range, should be rejected
OVER_REV=$(json_field "$BODY" overrides.revenue19)
if [[ -z "$OVER_REV" || "$OVER_REV" == "null" ]]; then
  pass "Invalid revenue19 '99' (too short) rejected by sanitizer"
else
  fail "Invalid revenue19 '99' should be rejected, got: $OVER_REV"
fi

# Reset
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1
note "Reset settings to null (back to defaults)"

cleanup_cashbook
summary
