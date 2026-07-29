#!/usr/bin/env bash
# e2e 139: Tier 115 — XRechnung 2.3.1 (UBL 2.1 + KoSIT
# 2.3.1 conformance). German B2B e-invoice mandatory
# since 2025-01-01 (Wachstumschancengesetz).
#
# Validates the v2 endpoints:
#   GET /api/v1/invoices/:id/xrechnung         (raw XML)
#   GET /api/v1/invoices/:id/xrechnung/validate (BR-* JSON)
#
# Test plan (10 sections, 50+ assertions):
#   0.  Wipe prior tier-115 fixtures
#   1.  Setup: create 4 customers (B2B, B2B-OSS, B2G, Skonto)
#   2.  B2B standard: download XRechnung + validate
#   3.  B2B reverse-charge: intra-EU with VAT-ID
#   4.  B2G: Leitweg-ID as BuyerReference
#   5.  Skonto: 2% / 14 Tage → AllowanceCharge block
#   6.  Validation: incomplete data → BR-06 / BR-09 errors
#   7.  Cross-tenant → 401
#   8.  Missing companyId → 400
#   9.  PDF endpoint still returns ZUGFeRD-embedded PDF
#  10.  Cleanup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"
TS=$(date +%s)
PREFIX="T115-$TS"
YEAR=2026

note "=== Test prefix: $PREFIX / year: $YEAR ==="

# ───── 0. Wipe prior tier-115 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'T115-%'
);
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'T115-%';
DELETE FROM "Customer" WHERE name LIKE 'T115-%' OR "customerNumber" LIKE 'T115-%';
SQL
pass "wiped prior tier-115 fixtures"

# Seed the SH Leder company address (the prod
# address is incomplete for XRechnung: city is empty).
# We save the original first to restore at the end.
ORIGINAL_ADDRESS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT address::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d '\n' | head -1)
ORIGINAL_BANK=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"bankInfo\"::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d '\n' | head -1)
ORIGINAL_SETTINGS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT settings::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d '\n' | head -1)

# Cleanup trap
cleanup() {
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'T115-%'
);
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'T115-%';
DELETE FROM "Customer" WHERE name LIKE 'T115-%' OR "customerNumber" LIKE 'T115-%';
UPDATE "Company" SET
  address = '${ORIGINAL_ADDRESS}'::jsonb,
  "bankInfo" = '${ORIGINAL_BANK}'::jsonb,
  settings = '${ORIGINAL_SETTINGS}'::jsonb
WHERE id = '$COMPANY_ID';
SQL
}
trap cleanup EXIT

# Update the company to have a complete address +
# a real-ish IBAN. The XRechnung validator
# (BR-06, BR-16) needs all postal address fields
# non-empty + a valid IBAN.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
UPDATE "Company" SET
  address = '{"street":"Otto-Hahn-Str. 24","city":"Dreieich","postalCode":"63303","country":"Deutschland"}'::jsonb,
  "bankInfo" = '{"bic":"HELADEFFXXX","iban":"DE89370400440532013000","bankName":"Commerzbank"}'::jsonb
WHERE id = '$COMPANY_ID';
SQL
pass "seeded company address + IBAN"

# ───── 1. Setup: 4 customers ─────
note "=== 1. Setup: 4 customers ==="
# (a) B2B — German buyer with VAT
# (b) B2B-OSS — Austrian buyer with VAT (intra-EU)
# (c) B2G — German public body with Leitweg-ID
# (d) Skonto — Standard B2B (for the Skonto test)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId", address, "paymentTerms", tags, "createdAt", "updatedAt")
VALUES
  -- (a) B2B
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2B Kunde GmbH', 'T115-${TS}-B2B',
   'DE123456789',
   '{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"Deutschland"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  -- (b) B2B-OSS (Austrian buyer)
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2B-OSS Kunde GmbH', 'T115-${TS}-OSS',
   'ATU12345678',
   '{"street":"Mariahilfer Str. 10","city":"Wien","postalCode":"1060","country":"Österreich"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  -- (c) B2G (with Leitweg-ID in address — koSIT B2G routing)
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2G Behörde', 'T115-${TS}-B2G',
   NULL,
   '{"street":"Behördenstr. 1","city":"Bonn","postalCode":"53111","country":"Deutschland","leitwegId":"991-12345-67"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  -- (d) Skonto customer (no special features, used for Skonto invoice)
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} Skonto Kunde', 'T115-${TS}-SK',
   'DE987654321',
   '{"street":"Skonto-Allee 5","city":"München","postalCode":"80331","country":"Deutschland"}'::jsonb,
   14, ARRAY['${PREFIX}']::text[], now(), now());
SQL
pass "created 4 customers"

# Helper to create an invoice via SQL
create_invoice() {
  local inv_num="$1" cust_num="$2" skonto_pct="${3:-0}" skonto_days="${4:-0}"
  local cust_id=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"customerNumber\"='$cust_num';" 2>&1 | tr -d ' ' | head -1)
  local inv_id="inv-${inv_num}"
  local net=1000
  local vat=190
  local total=1190
  if [ "$skonto_pct" != "0" ]; then
    net="1000.00"
    vat="190.00"
    total="1190.00"
  fi
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Invoice" (id, "companyId", "invoiceNumber", type, status, "issueDate", "dueDate",
                       "customerId", subtotal, "totalVat", total, currency, language,
                       "skontoPercent", "skontoDays",
                       "createdAt", "updatedAt")
VALUES
  ('${inv_id}'::text, '$COMPANY_ID', '${inv_num}', 'INV', 'sent',
   '${YEAR}-05-01', '${YEAR}-05-31',
   '${cust_id}'::text, ${net}, ${vat}, ${total}, 'EUR', 'de-DE',
   ${skonto_pct}, ${skonto_days}, now(), now());

INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate",
                           "netAmount", "vatAmount", "grossAmount", "sortOrder")
VALUES
  (gen_random_uuid()::text, '${inv_id}'::text, 'Beratungsleistung', 1.0, 1000.0, 0.19,
   1000.0, 190.0, 1190.0, 1);
SQL
  echo "$inv_id"
}

# ───── 2. B2B standard ─────
note "=== 2. B2B standard: download + validate ==="
INV_B2B=$(create_invoice "T115-${TS}-B2B" "T115-${TS}-B2B")
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID"
VAL_OK=$(json_field "$BODY" "valid")
test "$VAL_OK" = "True" && pass "B2B validate ok" || fail "B2B validate: $VAL_OK (body=$BODY)"

api_get "/api/v1/invoices/${INV_B2B}/xrechnung?companyId=$COMPANY_ID" -H "Accept: application/xml"
# Save the XML for content checks
echo "$BODY" > /tmp/t115-b2b.xml
# XRechnung 3.0 conformance (Tier 116 bumped 2.3.1 → 3.0)
grep -q "xrechnung_3.0" /tmp/t115-b2b.xml && pass "CustomizationID 3.0" \
  || fail "CustomizationID not 3.0 (xml=$(head -10 /tmp/t115-b2b.xml))"
# UBLVersionID = 2.1 (Tier 117)
grep -q "<cbc:UBLVersionID>2.1</cbc:UBLVersionID>" /tmp/t115-b2b.xml && pass "UBLVersionID 2.1" \
  || fail "UBLVersionID not 2.1"
# LineCountNumeric = 1
grep -q "<cbc:LineCountNumeric>1</cbc:LineCountNumeric>" /tmp/t115-b2b.xml && pass "LineCountNumeric 1" \
  || fail "LineCountNumeric not 1"
# BuyerReference must come AFTER DocumentCurrencyCode (Tier 117 XSD order fix)
LINE_BUYER=$(grep -n "<cbc:BuyerReference>" /tmp/t115-b2b.xml | head -1 | cut -d: -f1)
LINE_CURR=$(grep -n "<cbc:DocumentCurrencyCode" /tmp/t115-b2b.xml | head -1 | cut -d: -f1)
test "$LINE_BUYER" -gt "$LINE_CURR" && pass "BuyerReference after DocumentCurrencyCode (XSD order)" \
  || fail "BuyerReference (line $LINE_BUYER) not after DocumentCurrencyCode (line $LINE_CURR)"
# BuyerReference present
grep -q "<cbc:BuyerReference>" /tmp/t115-b2b.xml && pass "BuyerReference present" \
  || fail "BuyerReference missing"
# Supplier has DE:VAT scheme on EndpointID
grep -q 'schemeID="DE:VAT"' /tmp/t115-b2b.xml && pass "Supplier EndpointID scheme=DE:VAT" \
  || fail "Supplier EndpointID scheme not DE:VAT"
# PaymentMeans block with IBAN
grep -q "DE89370400440532013000" /tmp/t115-b2b.xml && pass "IBAN in PaymentMeans" \
  || fail "IBAN missing"
# DocumentCurrencyCode = EUR
grep -q "DocumentCurrencyCode.*EUR" /tmp/t115-b2b.xml && pass "DocumentCurrencyCode = EUR" \
  || fail "DocumentCurrencyCode not EUR"

# ───── 3. B2B-OSS (Austrian buyer) ─────
note "=== 3. B2B-OSS: Austrian buyer (AT VAT-ID) ==="
INV_OSS=$(create_invoice "T115-${TS}-OSS" "T115-${TS}-OSS")
api_get "/api/v1/invoices/${INV_OSS}/xrechnung?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t115-oss.xml
# Customer country should be "AT" (mapped from "Österreich")
grep -q '<cbc:IdentificationCode>AT</cbc:IdentificationCode>' /tmp/t115-oss.xml \
  && pass "Customer country normalised to AT" \
  || fail "Customer country not normalised to AT"
# Customer VAT-ID present
grep -q "ATU12345678" /tmp/t115-oss.xml && pass "Customer VAT-ID present" \
  || fail "Customer VAT-ID missing"

# ───── 4. B2G with Leitweg-ID ─────
note "=== 4. B2G: Leitweg-ID as BuyerReference ==="
# Set the company leitwegId in settings (used as
# BuyerReference for the customer; customer.address
# already has its own leitwegId which takes priority
# for the BuyerReference field).
INV_B2G=$(create_invoice "T115-${TS}-B2G" "T115-${TS}-B2G")
api_get "/api/v1/invoices/${INV_B2G}/xrechnung?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t115-b2g.xml
# BuyerReference = customer's leitwegId "991-12345-67"
grep -q "991-12345-67" /tmp/t115-b2g.xml && pass "Leitweg-ID as BuyerReference" \
  || fail "Leitweg-ID not in BuyerReference"

# ───── 5. Skonto invoice (2% / 14 Tage) ─────
note "=== 5. Skonto: 2% / 14 Tage → AllowanceCharge ==="
INV_SK=$(create_invoice "T115-${TS}-SK" "T115-${TS}-SK" 2 14)
api_get "/api/v1/invoices/${INV_SK}/xrechnung?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t115-sk.xml
# AllowanceCharge block present (BR-CO-21: Skonto must be an AllowanceCharge)
grep -q "<cac:AllowanceCharge>" /tmp/t115-sk.xml && pass "AllowanceCharge present (Skonto)" \
  || fail "AllowanceCharge missing for Skonto invoice"
# Reason = "Skonto 2.00%"
grep -q "Skonto 2.00%" /tmp/t115-sk.xml && pass "Skonto reason text" \
  || fail "Skonto reason text missing"
# ChargeIndicator = false (it's an allowance, not a charge)
grep -q "<cbc:ChargeIndicator>false</cbc:ChargeIndicator>" /tmp/t115-sk.xml \
  && pass "ChargeIndicator = false" \
  || fail "ChargeIndicator not false"
# Payment terms text
grep -q "Zahlbar innerhalb von 14 Tagen mit 2.00% Skonto" /tmp/t115-sk.xml \
  && pass "Payment terms text for Skonto" \
  || fail "Payment terms text missing"

# ───── 6. Validation: incomplete data → BR-06 / BR-09 errors ─────
note "=== 6. Validation: BR-06 + BR-09 errors on incomplete data ==="
# Set the company address back to incomplete (city = '')
# so the validator catches the missing field.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET address='{\"street\":\"x\",\"city\":\"\",\"postalCode\":\"12345\",\"country\":\"Deutschland\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID"
VAL_OK2=$(json_field "$BODY" "valid")
test "$VAL_OK2" = "False" && pass "validate fails with empty city" \
  || fail "validate should fail with empty city (got: $VAL_OK2)"
# Should have BR-06 error
HAS_BR06=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(e['rule']=='BR-06' for e in d.get('errors',[])))")
test "$HAS_BR06" = "True" && pass "BR-06 error present" \
  || fail "BR-06 error missing"
# BR-09: missing electronic address — wipe the supplier's VAT/tax IDs
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET \"vatId\"=NULL, \"taxId\"=NULL, address='{\"street\":\"x\",\"city\":\"x\",\"postalCode\":\"12345\",\"country\":\"Deutschland\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID"
HAS_BR09=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(any(e['rule']=='BR-09' for e in d.get('errors',[])))")
test "$HAS_BR09" = "True" && pass "BR-09 error present (no electronic address)" \
  || fail "BR-09 error missing"
# BR-1 v2: BuyerReference is mandatory — should always be present (we fall back to customer name)

# Restore company address + IBAN for the rest of the tests
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET address='{\"street\":\"Otto-Hahn-Str. 24\",\"city\":\"Dreieich\",\"postalCode\":\"63303\",\"country\":\"Deutschland\"}'::jsonb, \"vatId\"='DE308630106', \"bankInfo\"='{\"bic\":\"HELADEFFXXX\",\"iban\":\"DE89370400440532013000\",\"bankName\":\"Commerzbank\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null

# ───── 7. Cross-tenant → 401 ─────
note "=== 7. Cross-tenant: no x-user-id → 401 ==="
NO_AUTH=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/invoices/${INV_B2B}/xrechnung?companyId=$COMPANY_ID")
test "$NO_AUTH" = "401" && pass "xrechnung no x-user-id → 401" \
  || fail "xrechnung no x-user-id → $NO_AUTH (expected 401)"
NO_AUTH_V=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID")
test "$NO_AUTH_V" = "401" && pass "validate no x-user-id → 401" \
  || fail "validate no x-user-id → $NO_AUTH_V (expected 401)"

# ───── 8. Missing companyId → 401 (guard) ─────
note "=== 8. Missing x-company-id header → 401 (auth guard) ==="
# The HeaderAuthGuard requires BOTH x-user-id AND
# x-company-id headers. Missing x-company-id is
# always 401 (Unauthorized), not 400 (Bad Request).
NO_COMP=$(curl -sS -o /dev/null -w "%{http_code}" -H "x-user-id: $USER_ID" \
  "$API/api/v1/invoices/${INV_B2B}/xrechnung")
test "$NO_COMP" = "401" && pass "xrechnung no x-company-id → 401" \
  || fail "xrechnung no x-company-id → $NO_COMP (expected 401)"

# ───── 9. PDF endpoint still works (ZUGFeRD) ─────
note "=== 9. ZUGFeRD-embedded PDF still works ==="
PDF_STATUS=$(curl -sS -o /tmp/t115-zugferd.pdf -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/${INV_B2B}/zugferd?companyId=$COMPANY_ID")
test "$PDF_STATUS" = "200" && pass "ZUGFeRD PDF 200" \
  || fail "ZUGFeRD PDF → $PDF_STATUS"
# PDF magic bytes
MAGIC=$(head -c 4 /tmp/t115-zugferd.pdf | od -An -tx1 | tr -d ' \n')
test "$MAGIC" = "25504446" && pass "PDF magic bytes (%PDF)" \
  || fail "PDF magic bytes: $MAGIC"

# Cleanup tmp files
rm -f /tmp/t115-b2b.xml /tmp/t115-oss.xml /tmp/t115-b2g.xml /tmp/t115-sk.xml /tmp/t115-zugferd.pdf

summary "Tier 115 — XRechnung 2.3.1 (German e-invoice mandatory since 2025)"
