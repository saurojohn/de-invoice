#!/usr/bin/env bash
# e2e 81: Tier 54 — Invoice PDF with Skonto line +
# Gutschrift (CN) header.
#
# Validates:
#   1. The PDF of an invoice WITH skontoPercent +
#      skontoDays contains the standard German line
#      "Zahlbar bis <DD.MM.YYYY> mit <X>% Skonto,
#      bis <DD.MM.YYYY> ohne Abzug." at the bottom
#      footer area.
#   2. The Skonto-with date = issueDate + skontoDays.
#   3. The PDF of a regular INV (no Skonto) does NOT
#      contain the Skonto line.
#   4. The PDF of a Gutschrift (type='CN') shows
#      "GUTSCHRIFT" in the header and references
#      the original invoice number in the body.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ───── 0. Wipe prior tier-54 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT v.id FROM "Voucher" v
  LEFT JOIN "Invoice" i ON i."voucherRefId" = v.id
  WHERE i."invoiceNumber" LIKE 'Tier54%' OR i."invoiceNumber" LIKE 'CN-Tier54%'
);
DELETE FROM "Voucher" WHERE id IN (
  SELECT v.id FROM "Voucher" v
  LEFT JOIN "Invoice" i ON i."voucherRefId" = v.id
  WHERE i."invoiceNumber" LIKE 'Tier54%' OR i."invoiceNumber" LIKE 'CN-Tier54%'
);
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT i.id FROM "Invoice" i
  WHERE i."referenceInvoiceId" IN (
    SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier54%'
  )
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND ("invoiceNumber" LIKE 'Tier54%' OR "invoiceNumber" LIKE 'CN-Tier54%')
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND ("invoiceNumber" LIKE 'Tier54%' OR "invoiceNumber" LIKE 'CN-Tier54%');
SQL

# ───── 1. Seed customer ─────
CUST_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUST_ID" ]] || (echo "FATAL: customer not seeded" && exit 1)
pass "seeded customer: $CUST_ID"

# ───── 2. Create a Skonto invoice ─────
echo
note "=== 1. Create invoice with Skonto 2% / 14 Tage ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-07-05T00:00:00.000Z\",\"dueDate\":\"2026-07-31T00:00:00.000Z\",\"skontoPercent\":2,\"skontoDays\":14,\"items\":[{\"description\":\"Skonto test\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create Skonto invoice"
INV_ID=$(json_field "$BODY" id)
pass "seeded invoice: $INV_ID"

# ───── 3. Download the PDF + extract text ─────
# We need the binary PDF — use curl directly.
PDF_PATH="/tmp/tier54-skonto.pdf"
curl -s "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -o "$PDF_PATH"
[[ -s "$PDF_PATH" ]] || (echo "FATAL: PDF is empty" && exit 1)
pass "downloaded PDF ($(wc -c < "$PDF_PATH") bytes)"

# Extract text via pypdf (installed in venv or system-wide).
PDF_TEXT=$(python3 -c "
import pypdf
r = pypdf.PdfReader('$PDF_PATH')
out = ''
for p in r.pages:
    out += p.extract_text() or ''
print(out)
")
[[ -n "$PDF_TEXT" ]] || (echo "FATAL: no text extracted" && exit 1)

# The Skonto line must be present.
echo "$PDF_TEXT" | grep -q "Zahlbar bis 19.07.2026 mit 2% Skonto, bis 31.07.2026 ohne Abzug" \
  && pass "Skonto line on PDF" \
  || fail "Skonto line missing (expected: Zahlbar bis 19.07.2026 mit 2% Skonto, bis 31.07.2026 ohne Abzug)"

# ───── 4. Create a no-Skonto invoice + verify it has no Skonto line ─────
echo
note "=== 2. Create invoice without Skonto ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-07-05T00:00:00.000Z\",\"dueDate\":\"2026-07-31T00:00:00.000Z\",\"items\":[{\"description\":\"No Skonto\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create no-Skonto invoice"
INV2_ID=$(json_field "$BODY" id)

PDF2_PATH="/tmp/tier54-noskonto.pdf"
curl -s "http://localhost:3001/api/v1/invoices/$INV2_ID/pdf?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -o "$PDF2_PATH"
PDF2_TEXT=$(python3 -c "
import pypdf
r = pypdf.PdfReader('$PDF2_PATH')
out = ''
for p in r.pages:
    out += p.extract_text() or ''
print(out)
")
echo "$PDF2_TEXT" | grep -q "mit.*Skonto, bis" \
  && fail "no-Skonto invoice has Skonto line" \
  || pass "no-Skonto invoice has no Skonto line"

# ───── 5. Create a Gutschrift + verify the CN header ─────
echo
note "=== 3. Create Gutschrift + verify CN PDF ==="
api_post "/api/v1/invoices/$INV2_ID/credit-note?companyId=$COMPANY_ID" '{}'
assert_status "201" "create Gutschrift"
CN_ID=$(json_field "$BODY" id)
CN_NUM=$(json_field "$BODY" invoiceNumber)
pass "created CN: $CN_NUM"

PDF3_PATH="/tmp/tier54-cn.pdf"
curl -s "http://localhost:3001/api/v1/invoices/$CN_ID/pdf?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -o "$PDF3_PATH"
PDF3_TEXT=$(python3 -c "
import pypdf
r = pypdf.PdfReader('$PDF3_PATH')
out = ''
for p in r.pages:
    out += p.extract_text() or ''
print(out)
")
echo "$PDF3_TEXT" | grep -q "GUTSCHRIFT" \
  && pass "CN PDF has GUTSCHRIFT header" \
  || fail "CN PDF missing GUTSCHRIFT header"
echo "$PDF3_TEXT" | grep -q "Bezug zu Rechnung" \
  && pass "CN PDF has Bezug-zu-Rechnung section" \
  || fail "CN PDF missing Bezug-zu-Rechnung"

# ───── 6. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT i.id FROM "Invoice" i
  WHERE i."referenceInvoiceId" IN (
    SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier54%'
  )
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND ("invoiceNumber" LIKE 'Tier54%' OR "invoiceNumber" LIKE 'CN-Tier54%')
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND ("invoiceNumber" LIKE 'Tier54%' OR "invoiceNumber" LIKE 'CN-Tier54%');
SQL

summary
exit $?