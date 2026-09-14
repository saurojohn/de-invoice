#!/bin/bash
# Tier 372 — client errors must be 400s, not 500s (and not silent 200s)
#
# Each case below used to answer HTTP 500, or 200 for a request that should
# have been rejected:
#
#   - POST /invoices: InvoiceItemDto / CreateInvoiceDto had no bounds. Two kinds
#     of bad value got through. Values beyond their Decimal column — vatRate 19
#     (Decimal(5,4) holds at most 9.9999) or quantity 1e9 (Decimal(12,4)) —
#     failed in Postgres with "numeric field overflow" → 500 (measured for
#     vatRate 19). Values that FIT the column but are meaningless — vatRate 5,
#     discountPercent 150 (Decimal(5,2) holds up to 999.99) — had no check at
#     all; they were not measured before the fix, so this spec does not claim
#     what they returned. Both kinds are now 400, bounded like the expense /
#     cashbook / product DTOs (vatRate 0..1) and like skontoPercent (0..100).
#   - GET /invoices/:id/pdf without ?companyId=: the auth guard reads the
#     x-company-id HEADER, so the request passed auth and then Prisma threw on
#     an undefined companyId → 500 "PDF generation failed".
#   - GET /reports/vat without year, or with year=abc: parseInt → NaN → Invalid
#     Date → 500. quarter=9 and month=13 were answered with 200 and a report for
#     a period that does not exist.
#
# A sweep of all 182 parameter-less GET routes without companyId found only the
# /reports/vat case, so the missing-companyId 500 was not a wider pattern.
#
# The valid-request assertions matter as much as the 400s: the new bounds must
# not reject anything the application legitimately sends.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

MUELLER="b9799545-956b-40db-8fcd-769b2d429aa9"
TODAY="$(date +%Y-%m-%d)"
inv() {
  # $1 quantity, $2 vatRate, $3 extra top-level JSON (with a leading comma)
  echo "{\"customerId\":\"$MUELLER\",\"issueDate\":\"$TODAY\"${3:-},\"items\":[{\"description\":\"e2e-173\",\"quantity\":$1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":$2}]}"
}

note "=== 1. invoice create: valid requests still succeed ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 0.19)"
assert_status 201 "vatRate 0.19"
INVOICE_ID=$(json_field "$BODY" id)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 0)"
assert_status 201 "vatRate 0 (tax-exempt line)"
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 0.19 ',"discountPercent":10')"
assert_status 201 "discountPercent 10"

note "=== 2. invoice create: out-of-range values are 400, not 500 ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 19)"
assert_status 400 "vatRate 19 (a percentage, not a fraction)"
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 -0.1)"
assert_status 400 "negative vatRate"
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1000000000 0.19)"
assert_status 400 "quantity beyond the Decimal(12,4) column"
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$(inv 1 0.19 ',"discountPercent":150')"
assert_status 400 "discountPercent 150"

note "=== 3. invoice PDF: missing companyId is 400; with it, a PDF ==="
PDF_FILE=/tmp/t173_invoice.pdf
NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INVOICE_ID/pdf")
assert_eq "PDF without ?companyId= is a client error" "$NO_CID" "400"
WITH_CID=$(curl -sS -o "$PDF_FILE" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INVOICE_ID/pdf?companyId=$COMPANY_ID")
assert_eq "PDF with companyId" "$WITH_CID" "200"
assert_eq "PDF magic header" "$(head -c 5 "$PDF_FILE" 2>/dev/null)" "%PDF-"

note "=== 4. /reports/vat: defaults, and invalid periods are 400 ==="
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID"
assert_status 200 "no year → defaults to the current year (like /sales)"
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&quarter=2"
assert_status 200 "valid year + quarter"
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&month=6"
assert_status 200 "valid year + month"
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=abc"
assert_status 400 "year=abc"
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&quarter=9"
assert_status 400 "quarter=9 (was a silent 200)"
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&month=13"
assert_status 400 "month=13 (was a silent 200)"

summary
