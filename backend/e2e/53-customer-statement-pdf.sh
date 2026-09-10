#!/bin/bash
# e2e/53-customer-statement-pdf.sh — Tier 20
#
# Verifies GET /api/v1/customers/:id/statement.pdf returns a
# valid PDF with the expected German content + structure:
#   - PDF magic header
#   - PDFKit metadata (Title, Producer, Author)
#   - Document body contains "Kontoauszug", customer name,
#     Saldo labels, "Anfangsbestand", "Endsaldo"
#   - Reasonable file size (not empty, not 10MB either)
#   - Content-Disposition header for download
#
# Doesn't depend on pdftotext — uses a Python helper that
# extracts text streams from the PDF byte stream. PDFKit
# encodes text with Tj operators in uncompressed content
# streams (we use no compression) so the strings are
# directly readable in the bytes.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

FAILS=0
TEST_TAG="tier20-pdf-$$"
TEST_EMAIL="${TEST_TAG}@example.com"

# ── Setup: create test customer + invoices ──────────────
note "Setting up test data..."
api_post "/api/v1/customers?companyId=$COMPANY_ID" '{
  "type": "business",
  "name": "Tier20 PDF Test Co",
  "address": {"street":"Hauptstr 5","city":"München","postalCode":"80331","country":"DE"},
  "contact": {"email":"'$TEST_EMAIL'"},
  "paymentTerms": 30
}'
[[ "$STATUS" == "201" ]] || { fail "create customer failed: $BODY"; exit 1; }
CUSTOMER_ID=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# Cleanup
cleanup() {
  if [[ -n "${CUSTOMER_ID:-}" ]]; then
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Payment\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"customerId\"='$CUSTOMER_ID');" >/dev/null 2>&1 || true
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Invoice\" WHERE \"customerId\"='$CUSTOMER_ID';" >/dev/null 2>&1 || true
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Customer\" WHERE id='$CUSTOMER_ID';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Create one invoice + payment
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "{
  \"customerId\":\"$CUSTOMER_ID\",
  \"issueDate\":\"2026-05-15T00:00:00.000Z\",
  \"items\":[{\"description\":\"Test\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]
}"
[[ "$STATUS" == "201" ]] || { fail "create invoice failed: $BODY"; exit 1; }
INV_ID=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
pass "setup complete (customer + invoice)"

# ── Test 1: PDF endpoint returns 200 with application/pdf ──
note "Requesting PDF..."
PDF_FILE=$(mktemp).pdf
HTTP=$(curl -s -o "$PDF_FILE" -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement.pdf?companyId=$COMPANY_ID&from=2026-05-01&to=2026-05-31")
HTTP_CODE="${HTTP%%|*}"
HTTP_TYPE="${HTTP##*|}"
assert_eq "PDF endpoint returns 200" "$HTTP_CODE" "200"
assert_eq "Content-Type is application/pdf" "$HTTP_TYPE" "application/pdf"

# ── Test 2: PDF has valid magic header ──
MAGIC=$(head -c 5 "$PDF_FILE")
[[ "$MAGIC" == "%PDF-"* ]] && pass "PDF starts with %PDF-" || fail "PDF should start with %PDF-, got: $MAGIC"

# ── Test 3: file size is reasonable (1KB - 500KB) ──
SIZE=$(wc -c < "$PDF_FILE" | tr -d ' ')
if [[ $SIZE -lt 1024 ]]; then
  fail "PDF too small: $SIZE bytes (suspicious — empty?)"
elif [[ $SIZE -gt 524288 ]]; then
  fail "PDF too large: $SIZE bytes (suspicious — runaway?)"
else
  pass "PDF size reasonable: $SIZE bytes"
fi

# ── Test 4: PDFKit is the producer (custom Producer string) ──
# PDFKit writes the producer as `(PDFKit)` inside a PDF object
# so strings will find it.
PDF_PRODUCER=$(strings "$PDF_FILE" 2>/dev/null | grep -F "PDFKit" | head -1 || echo "")
[[ "$PDF_PRODUCER" == *PDFKit* ]] && pass "PDF Producer is PDFKit" || fail "PDF Producer should mention PDFKit, got: $PDF_PRODUCER"

# ── Test 5: PDF Title metadata contains "Kontoauszug" ──
TITLE=$(strings "$PDF_FILE" 2>/dev/null | grep -F "Kontoauszug" | head -1 || echo "")
[[ "$TITLE" == *Kontoauszug* ]] && pass "PDF Title contains 'Kontoauszug'" || fail "PDF Title should mention Kontoauszug, got: $TITLE"

# ── Test 6: body text contains German labels ──
# Use pypdf to extract text (PDFKit uses FlateDecode compression
# which strings can't read directly).
BODY_TEXT=$(python3 -c "
try:
    from pypdf import PdfReader
    r = PdfReader('$PDF_FILE')
    text = ''
    for page in r.pages:
        text += page.extract_text() + ' '
    print(text)
except Exception as e:
    print(f'ERROR: {e}')
")

# Helper: check substring
check_substr() {
  local label="$1" needle="$2"
  if echo "$BODY_TEXT" | grep -qF "$needle"; then
    pass "$label  (found: $needle)"
  else
    fail "$label  (missing: $needle)"
  fi
}

check_substr "Body has 'Kontoauszug' title" "Kontoauszug"
check_substr "Body has 'Anfangsbestand' label" "Anfangsbestand"
check_substr "Body has 'Endsaldo' label" "Endsaldo"
check_substr "Body has 'Summe Rechnungen' label" "Summe Rechnungen"
check_substr "Body has 'Summe Zahlungen' label" "Summe Zahlungen"
check_substr "Body has 'Datum' column header" "Datum"
check_substr "Body has 'Betrag' column header" "Betrag"
check_substr "Body has 'Saldo' column header" "Saldo"
check_substr "Body has 'Buchungstext' column header" "Buchungstext"
check_substr "Body has 'Beleg' column header" "Beleg"
check_substr "Body has customer name" "Tier20 PDF Test Co"
check_substr "Body has letterhead 'SH Leder'" "SH Leder"
check_substr "Body has 'Rechnung' line type" "Rechnung"
check_substr "Body has 'Saldostichtag' label" "Saldostichtag"
check_substr "Body has German 'Bis' or 'Zeitraum'" "Zeitraum"

# ── Test 7: PDF for nonexistent customer returns 404 ──
FAKE_CUST="00000000-0000-0000-0000-000000000998"
HTTP_404=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$FAKE_CUST/statement.pdf?companyId=$COMPANY_ID&from=2026-05-01&to=2026-05-31")
assert_eq "PDF for nonexistent customer returns 404" "$HTTP_404" "404"

# ── Test 8: PDF for missing from/to returns 400 ──
HTTP_400=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement.pdf?companyId=$COMPANY_ID")
assert_eq "PDF without from/to returns 400" "$HTTP_400" "400"

# ── Test 9: Content-Disposition has attachment + .pdf extension ──
DISPOSITION=$(curl -sI -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement.pdf?companyId=$COMPANY_ID&from=2026-05-01&to=2026-05-31" \
  | grep -i "content-disposition" | tr -d '\r')
echo "$DISPOSITION" | grep -qi "attachment" && pass "Content-Disposition has attachment" || fail "Content-Disposition should have attachment: $DISPOSITION"
echo "$DISPOSITION" | grep -qF ".pdf" && pass "Content-Disposition has .pdf filename" || fail "Content-Disposition should have .pdf: $DISPOSITION"
echo "$DISPOSITION" | grep -qi "kontoauszug" && pass "Content-Disposition has Kontoauszug in filename" || fail "Content-Disposition should mention Kontoauszug: $DISPOSITION"

rm -f "$PDF_FILE"

echo ""
echo "==============================="
if [[ $FAILS -eq 0 ]]; then
  echo "53-customer-statement-pdf: ALL PASSED ✓"
  exit 0
else
  echo "53-customer-statement-pdf: $FAILS FAILURE(S)"
  exit 1
fi