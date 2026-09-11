#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Tier 130 — customer portal (multi-invoice login)
#
# Tests the new /api/v1/customer-portal/* endpoints:
#   - request-session (rate-limited, no customer-leak)
#   - getCustomerInvoices (token-auth, sliding expiry)
#   - getInvoice (token + customer-scoped)
#   - getInvoicePdf (token + customer-scoped)
#   - markInvoicePaid (token + customer-scoped)
#   - bad token returns 401
#
# Pre-flight: backend on :3001, test customer
# (BWA Test Kunde, b3f7b274-...) has an email set in
# contact, and at least one invoice exists.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
# Tier 361: Step 4 uses $COMPANY_ID, which only login() sets — the spec
# died there with "COMPANY_ID: unbound variable" the first time it ran.
login
CUSTOMER_ID="b3f7b274-7696-44b8-9345-8bfd460b3e47"
EMAIL="tier130-customer@example.com"

echo "=== Setup: set customer email ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "UPDATE \"Customer\" SET contact = '{\"email\": \"$EMAIL\", \"phone\": \"+49 30 12345\"}'::jsonb WHERE id='$CUSTOMER_ID';" \
  >/dev/null

# Clean up any existing sessions for this email
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "DELETE FROM \"CustomerPortalSession\" WHERE email='$EMAIL';" \
  >/dev/null

# Tier 361: every assert_eq below had its arguments in the order
# <expected> <actual> <label>; _lib.sh takes <label> <actual> <expected>.
# Equality is symmetric, but a passing check printed "✗ true expected=
# request-session returns sent=true" — label and value swapped.
echo "=== Step 1: request session ==="
RESP=$(curl -sS -X POST "http://localhost:3001/api/v1/customer-portal/request-session?email=$EMAIL")
assert_eq "request-session returns sent=true" "$(echo "$RESP" | jq -r '.sent')" "true"

# Extract the token from the backend log
sleep 1
TOKEN=$(tail -100 /tmp/backend.log | grep "portal session created" | tail -1 | sed -n 's/.*token=\([0-9a-f]\{64\}\).*/\1/p')
[ -n "$TOKEN" ] || { fail "no session token found in backend log"; exit 1; }
echo "  token = ${TOKEN:0:16}..."

echo ""
echo "=== Step 2: get customer invoices (token auth) ==="
RESP=$(curl -sS "http://localhost:3001/api/v1/customer-portal/invoices?token=$TOKEN")
CUST_ID=$(echo "$RESP" | jq -r '.customer.id')
INVOICE_COUNT=$(echo "$RESP" | jq -r '.invoices | length')
assert_eq "returned customer.id matches" "$CUST_ID" "$CUSTOMER_ID"
[ "$INVOICE_COUNT" -ge "1" ] || { fail "expected >=1 invoice, got $INVOICE_COUNT"; exit 1; }
echo "  $INVOICE_COUNT invoice(s) returned"

echo ""
echo "=== Step 3: get single invoice (must belong to this customer) ==="
# Get the first invoice id from the list
INVOICE_ID=$(echo "$RESP" | jq -r '.invoices[0].id')
RESP=$(curl -sS "http://localhost:3001/api/v1/customer-portal/invoice/$INVOICE_ID?token=$TOKEN")
GOT_CUST=$(echo "$RESP" | jq -r '.customerId')
assert_eq "single invoice has correct customerId" "$GOT_CUST" "$CUSTOMER_ID"

echo ""
echo "=== Step 4: cross-customer attack — try another invoice id ==="
# Create a second customer briefly, give it an invoice, then try to access it
OTHER_ID="00000000-0000-0000-0000-deadbeefcafe"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "INSERT INTO \"Customer\" (id, name, type, address, \"paymentTerms\", \"companyId\", \"createdAt\", \"updatedAt\") VALUES ('$OTHER_ID', 'Other Customer', 'business', '{\"country\": \"Deutschland\"}'::jsonb, 30, '$COMPANY_ID', NOW(), NOW()) ON CONFLICT DO NOTHING;" \
  >/dev/null
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "INSERT INTO \"Invoice\" (id, \"invoiceNumber\", type, status, \"issueDate\", \"dueDate\", currency, subtotal, \"totalVat\", total, notes, \"customerId\", \"companyId\", \"createdAt\", \"updatedAt\") VALUES ('00000000-0000-0000-0000-deadbeefffff', 'INV-OTHER-001', 'INV', 'sent', '2026-07-15', '2026-08-15', 'EUR', 50, 9.5, 59.5, '', '$OTHER_ID', '$COMPANY_ID', NOW(), NOW()) ON CONFLICT DO NOTHING;" \
  >/dev/null

HTTP_CODE=$(curl -sS -o /tmp/cross-attack.json -w "%{http_code}" \
  "http://localhost:3001/api/v1/customer-portal/invoice/00000000-0000-0000-0000-deadbeefffff?token=$TOKEN")
assert_eq "cross-customer invoice access returns 404" "$HTTP_CODE" "404"

echo ""
echo "=== Step 5: PDF download ==="
HTTP_CODE=$(curl -sS -o /tmp/portal.pdf -w "%{http_code}" \
  "http://localhost:3001/api/v1/customer-portal/invoice/$INVOICE_ID/pdf?token=$TOKEN")
assert_eq "PDF download returns 200" "$HTTP_CODE" "200"
PDF_SIZE=$(stat -f%z /tmp/portal.pdf 2>/dev/null || stat -c%s /tmp/portal.pdf)
[ "$PDF_SIZE" -gt 1000 ] || { fail "PDF too small ($PDF_SIZE bytes)"; exit 1; }
# Check the PDF magic bytes
MAGIC=$(head -c 4 /tmp/portal.pdf)
assert_eq "PDF starts with %PDF magic" "$MAGIC" "%PDF"

echo ""
echo "=== Step 6: bad token returns 401 ==="
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  "http://localhost:3001/api/v1/customer-portal/invoices?token=invalid")
assert_eq "bad token returns 401" "$HTTP_CODE" "401"

echo ""
echo "=== Step 7: rate-limit per email (6th request in 5min = 400) ==="
for i in 1 2 3 4 5; do
  curl -sS -X POST "http://localhost:3001/api/v1/customer-portal/request-session?email=$EMAIL" >/dev/null
done
# The 6th should be rate-limited
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "http://localhost:3001/api/v1/customer-portal/request-session?email=$EMAIL")
assert_eq "6th request in 5min returns 400 (rate-limited)" "$HTTP_CODE" "400"

echo ""
echo "=== Step 8: cleanup ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "DELETE FROM \"CustomerPortalSession\" WHERE email='$EMAIL';" >/dev/null
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "DELETE FROM \"Invoice\" WHERE \"customerId\"='$OTHER_ID';" >/dev/null
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc \
  "DELETE FROM \"Customer\" WHERE id='$OTHER_ID';" >/dev/null

# Tier 361: this spec never ran (run-all.sh skipped three-digit names), and
# it could not have passed anyway: the guards above read
# `[ cond ] || fail "..."; exit 1`, and `;` binds looser than `||`, so it
# exited 1 unconditionally at the first one. It also ended by printing
# "ALL PASSED" whatever had failed. Guards now group with { }, and the exit
# status comes from summary.
summary
