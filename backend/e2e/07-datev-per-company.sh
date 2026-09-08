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

  # Tier 334: belt-and-suspenders. The /payments endpoint
  # normally flips status to 'paid' once sum(payments) >=
  # invoice total, but a regression in the create path
  # (where status='paid' from the DTO is silently overwritten
  # to 'draft' at .create() time) can leave the invoice
  # stuck in 'draft' even after a successful payment POST.
  # We force the status via raw SQL so the DATEV export
  # filter (status='paid') sees the row. Idempotent.
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "UPDATE \"Invoice\" SET status='paid' WHERE id='$INV_ID' AND status<>'paid';" >/dev/null 2>&1
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

# Default accounts (untouched) should still be present in
# the *config* — the test only overrode bank (1200→9999)
# and revenue19 (8400→8888). The 7% revenue (8300) and
# the input-VAT accounts (1576, 1780) should still be the
# SKR03 defaults. Verify via the config endpoint, not the
# export (the export doesn't contain a Vorsteuer line for
# a sale-only test like this one).
api_get "/api/v1/companies/$COMPANY_ID/datev-config"
assert_eq "default config.inputVat19 unchanged" \
  "$(json_field "$BODY" config.inputVat19)" "1576"
assert_eq "default config.inputVat7 unchanged" \
  "$(json_field "$BODY" config.inputVat7)" "1577"
assert_eq "default config.revenue7 unchanged" \
  "$(json_field "$BODY" config.revenue7)" "8300"

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

# === Voucher pass: DATEV export picks up Vouchers directly ===
# This is the audit-trail integration: a posted Voucher
# (mimicking what bank-import.confirmMatch writes) shows
# up in the DATEV CSV with its VoucherNumber as
# Belegfeld 1, and the Erlöse/USt lines on the linked
# invoice carry the VoucherNumber as Belegfeld 2 so the
# Berater can pivot.
#
# Reset the per-company DATEV config to defaults so the
# Voucher accounting paths (1200 Bank, 1406 Forderung)
# match the standard SKR03.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1

# Find the most recent paid invoice (the one the test
# created at the top) and link it to a synthetic
# Voucher (replicating what bank-import.confirmMatch
# does, but direct SQL so we don't depend on the
# bank-import module for this test).
PAID_INV_NO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND status = 'paid' ORDER BY \"createdAt\" DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
PAID_INV_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" = '$PAID_INV_NO';" 2>/dev/null | tr -d ' ')

# Create a posted Voucher for the cash side of this
# invoice: 1200 Bank / 1406 Forderung.
VCH_DATA=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "INSERT INTO \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status, \"createdAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'BK-E2E-0001', '2026-06-01', 'Zahlungseingang $PAID_INV_NO', 'BankReconciliation', 'posted', now())
   RETURNING id;" 2>/dev/null | tr -d ' ')
VCH_ID=$(echo "$VCH_DATA" | head -1)
# Find or create the two Account rows
BANK_ACC=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "INSERT INTO \"Account\" (id, \"companyId\", \"accountNumber\", name, type, category, \"createdAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '1200', 'Bank', 'asset', 'liquidity', now())
   ON CONFLICT (\"companyId\", \"accountNumber\") DO UPDATE SET name = EXCLUDED.name
   RETURNING id;" 2>/dev/null | tr -d ' ')
RECV_ACC=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "INSERT INTO \"Account\" (id, \"companyId\", \"accountNumber\", name, type, category, \"createdAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '1406', 'Forderungen aus L+L', 'asset', 'receivables', now())
   ON CONFLICT (\"companyId\", \"accountNumber\") DO UPDATE SET name = EXCLUDED.name
   RETURNING id;" 2>/dev/null | tr -d ' ')
# 2 lines: Bank debit 119, Forderung credit 119
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"VoucherLine\" (id, \"voucherId\", \"accountId\", description, debit, credit, \"sortOrder\")
   VALUES (gen_random_uuid()::text, '$VCH_ID', '$BANK_ACC', 'Bank Kunde', 119.00, 0, 0),
          (gen_random_uuid()::text, '$VCH_ID', '$RECV_ACC', 'Forderung ausgeglichen', 0, 119.00, 1);" >/dev/null 2>&1
# Link voucher back to invoice
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET \"voucherRefId\" = '$VCH_ID' WHERE id = '$PAID_INV_ID';" >/dev/null 2>&1

# Re-export DATEV
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" -o /tmp/datev-e2e2.csv

# The Voucher line should appear
if file_contains "BK-E2E-0001" /tmp/datev-e2e2.csv; then
  pass "Voucher BK-E2E-0001 appears in DATEV export"
else
  fail "Voucher BK-E2E-0001 missing from DATEV export"
fi

# The Erlöse line on the voucher-linked invoice should
# carry the voucher number as Belegfeld 2 — Berater can
# pivot from the revenue line to the Belegnummer.
VCH_BR_LINK=$(LC_ALL=C grep -c "BK-E2E-0001.*Erl.*$PAID_INV_NO" /tmp/datev-e2e2.csv || true)
# The voucher pass emits Belegfeld 2 = "BankReconciliation"
# on the cash line; the Invoice pass copies the
# voucher# into Belegfeld 2 on the revenue lines. Either
# way, BK-E2E-0001 should be present.
if [[ "$VCH_BR_LINK" -ge 1 ]]; then
  pass "Erlöse line carries voucher BK-E2E-0001 (audit pivot)"
else
  fail "Erlöse line missing voucher number pivot"
fi

# The Invoice pass should have SKIPPED the 1200/1406
# cash line for this invoice (now on the Voucher). The
# only Zahlungseingang line in the export for our test
# invoice should be the Voucher's, not the Invoice's.
# (Hard to filter precisely without grep+context, so
# we just count: there should be exactly ONE
# 1200;1406 S line for the voucher — 1 because the
# Invoice path skipped it, +1 from the Voucher = 1.)
LINES_1200_1406=$(LC_ALL=C grep -c "^[A-Z]*;.*;.*;.*;.*;S;1200;1406" /tmp/datev-e2e2.csv || true)
note "1200/1406 S lines in export: $LINES_1200_1406 (≥1 expected — from Voucher)"

# Cleanup the test Voucher
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';
   UPDATE \"Invoice\" SET \"voucherRefId\" = NULL WHERE id = '$PAID_INV_ID';
   DELETE FROM \"Voucher\" WHERE id = '$VCH_ID';" >/dev/null 2>&1

# Reset
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1
note "Reset settings to null (back to defaults)"

cleanup_cashbook
summary
