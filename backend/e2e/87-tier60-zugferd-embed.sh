#!/usr/bin/env bash
# e2e 87: Tier 60 — Single PDF endpoint defaults to ZUGFeRD
# (Factur-X / EN16931), with ?format= query param for
# explicit format selection.
#
# Validates:
#   1. GET /invoices/:id/pdf (no format) returns a PDF
#      with embedded factur-x.xml — CrossIndustryInvoice
#      schema, EN16931 conformance, AFRelationship=Source.
#   2. The XMP metadata carries Factur-X 2.1 / EN16931
#      tags (PDF/A-3 part B).
#   3. ?format=zugferd (explicit) returns the same shape.
#   4. ?format=pdf returns a plain PDF with NO embedded
#      factur-x.xml (legacy compatibility).
#   5. ?format=xrechnung returns application/xml (XRechnung
#      UBL 2.1 schema, not application/pdf).
#   6. The Content-Disposition filename reflects the format:
#      `<number>_einvoice.pdf` for ZUGFeRD, `<number>.pdf`
#      for plain, `<number>_xrechnung.xml` for XML.
#   7. PDF starts with %PDF- magic + has the visual
#      SH Leder content (sanity: not a 500-error JSON
#      rendered as PDF).
#   8. Filename on default response ends with
#      `_einvoice.pdf` (the EU B2B convention).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# ───── 0. Wipe prior tier-60 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Payment"          WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%'
);
DELETE FROM "InvoiceItem"      WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%'
);
DELETE FROM "Invoice"          WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%';
SQL
pass "wiped prior tier-60 fixtures"

# ───── 1. Seed an invoice (use existing customer) ─────
CUST_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name LIKE 'Müller%' LIMIT 1")
if [[ -z "$CUST_ID" ]]; then
  # Polish #10: seed a self-sufficient Müller customer. Earlier
  # the 65 cleanup wiped all customers, so 87 saw 0 in batch runs.
  T60_EMAIL="t60-$(date +%s)@example.com"
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c "
    DELETE FROM \"SepaDirectDebitMandate\"   WHERE \"companyId\" = '$COMPANY_ID' AND \"debitorName\" = 'Müller GmbH';
    DELETE FROM \"Customer\"                  WHERE \"companyId\" = '$COMPANY_ID' AND \"name\" = 'Müller GmbH';" >/dev/null 2>&1
  api_post "/api/v1/customers?companyId=$COMPANY_ID" \
    "{\"name\":\"Müller GmbH\",\"type\":\"business\",\"address\":{\"street\":\"Musterstr 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"},\"contact\":{\"email\":\"$T60_EMAIL\"}}"
  assert_status 201 "seed Müller customer"
  CUST_ID=$(json_field "$BODY" id)
fi
TODAY=$(date -u +%Y-%m-%dT00:00:00.000Z)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"$TODAY\",\"dueDate\":\"$TODAY\",\"items\":[{\"description\":\"Tier60 ZUGFeRD test\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status 201 "create invoice"
INV_ID=$(json_field "$BODY" id)
INV_NUM=$(json_field "$BODY" invoiceNumber)
pass "seeded invoice: $INV_NUM ($INV_ID)"

# ───── 2. Default (no ?format=) — must be ZUGFeRD ─────
echo
note "=== 1. default format = ZUGFeRD (embedded Factur-X) ==="
TMPDIR=$(mktemp -d)
DEFAULT_PDF="$TMPDIR/default.pdf"
DEFAULT_HEADERS="$TMPDIR/default.hdr"
STATUS=$(curl -sS -o "$DEFAULT_PDF" -D "$DEFAULT_HEADERS" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID")
[[ "$STATUS" == "200" ]] && pass "GET /invoices/:id/pdf (default) (HTTP 200)" || fail "expected 200, got $STATUS"

# File must start with %PDF-
HEAD=$(head -c 5 "$DEFAULT_PDF" | tr -d '\0')
assert_eq "PDF magic header" "$HEAD" "%PDF-"

# Embedded factur-x.xml is in the binary.
# Use `wc -l` on the grep output to count lines (each
# match is on its own line) — `grep -c` exits 1 on no
# match which would also trigger the `|| echo 0` and
# concatenate "0\n0" in the var. `wc -l` is simpler.
FACTUR_HITS=$(grep -a "factur-x" "$DEFAULT_PDF" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$FACTUR_HITS" -ge 2 ]]; then
  pass "embedded factur-x.xml present ($FACTUR_HITS references)"
else
  fail "expected ≥2 factur-x references in PDF, got $FACTUR_HITS"
fi

# XMP must declare Factur-X 2.1 / EN16931
if grep -q "fx:Version>2.1\|Factur-X 2.1" "$DEFAULT_PDF"; then
  pass "XMP declares Factur-X 2.1"
else
  fail "XMP does not declare Factur-X 2.1"
fi
if grep -q "EN16931" "$DEFAULT_PDF"; then
  pass "XMP declares EN16931 conformance"
else
  fail "XMP does not declare EN16931"
fi
if grep -q "pdfaid:part>3" "$DEFAULT_PDF"; then
  pass "XMP declares PDF/A-3 (required for ZUGFeRD)"
else
  fail "XMP does not declare PDF/A-3"
fi

# Content-Disposition filename must end in _einvoice.pdf
# (or _einvoice_signed.pdf since Tier 165 — the
# controller now adds the _signed suffix when
# the PDF is signed).
DEFAULT_CD=$(grep -i "^content-disposition:" "$DEFAULT_HEADERS" | tr -d '\r')
if echo "$DEFAULT_CD" | grep -qE "${INV_NUM}_einvoice(_signed)?\.pdf"; then
  pass "default filename ends in _einvoice.pdf"
else
  fail "default filename does not end in _einvoice.pdf: $DEFAULT_CD"
fi

# ───── 3. ?format=zugferd — same as default ─────
echo
note "=== 2. ?format=zugferd explicit — same as default ==="
EXPLICIT_PDF="$TMPDIR/explicit.pdf"
EXPLICIT_STATUS=$(curl -sS -o "$EXPLICIT_PDF" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID&format=zugferd")
[[ "$EXPLICIT_STATUS" == "200" ]] && pass "GET ?format=zugferd (HTTP 200)" || fail "expected 200, got $EXPLICIT_STATUS"
EXPL_FACTUR=$(grep -a "factur-x" "$EXPLICIT_PDF" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$EXPL_FACTUR" -ge 2 ]]; then
  pass "explicit format=zugferd also embeds Factur-X"
else
  fail "explicit format=zugferd missing factur-x ($EXPL_FACTUR references)"
fi

# ───── 4. ?format=pdf — plain PDF, no embedded XML ─────
echo
note "=== 3. ?format=pdf — plain PDF, no XML ==="
PLAIN_PDF="$TMPDIR/plain.pdf"
PLAIN_HEADERS="$TMPDIR/plain.hdr"
PLAIN_STATUS=$(curl -sS -o "$PLAIN_PDF" -D "$PLAIN_HEADERS" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID&format=pdf")
[[ "$PLAIN_STATUS" == "200" ]] && pass "GET ?format=pdf (HTTP 200)" || fail "expected 200, got $PLAIN_STATUS"
PLAIN_HEAD=$(head -c 5 "$PLAIN_PDF" | tr -d '\0')
assert_eq "plain PDF magic" "$PLAIN_HEAD" "%PDF-"
PLAIN_FACTUR=$(grep -a "factur-x" "$PLAIN_PDF" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "plain PDF has no factur-x" "$PLAIN_FACTUR" "0"

# Content-Disposition should be `<num>.pdf` (no _einvoice suffix)
PLAIN_CD=$(grep -i "^content-disposition:" "$PLAIN_HEADERS" | tr -d '\r')
# Accept both the bare `<num>.pdf` and the
# Tier 165 `<num>_signed.pdf` (the controller
# adds _signed when the PDF is signed).
if echo "$PLAIN_CD" | grep -qE "filename=\"${INV_NUM}(_signed)?\.pdf\""; then
  pass "plain PDF filename is <num>.pdf (no _einvoice suffix)"
else
  fail "plain PDF filename has unexpected suffix: $PLAIN_CD"
fi

# ───── 5. ?format=xrechnung — XML, not PDF ─────
echo
note "=== 4. ?format=xrechnung — application/xml ==="
XML_FILE="$TMPDIR/xrechnung.xml"
HEADERS_FILE="$TMPDIR/xrech.hdr"
XRECH_STATUS=$(curl -sS -o "$XML_FILE" -D "$HEADERS_FILE" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID&format=xrechnung")
assert_eq "xrechnung status" "$XRECH_STATUS" "200"
XRECH_CTYPE=$(grep -i "^content-type:" "$HEADERS_FILE" | tr -d '\r' | cut -d':' -f2- | xargs)
if [[ "$XRECH_CTYPE" == application/xml* ]]; then
  pass "xrechnung content-type = $XRECH_CTYPE"
else
  fail "xrechnung content-type should be application/xml, got: $XRECH_CTYPE"
fi

# Validate XML structure (UBL 2.1 / XRechnung)
if head -1 "$XML_FILE" | grep -q "<?xml"; then
  pass "XRechnung starts with <?xml"
else
  fail "XRechnung not valid XML"
fi
if grep -q "Invoice " "$XML_FILE" || grep -q "<Invoice" "$XML_FILE"; then
  pass "XRechnung contains <Invoice> root"
else
  fail "XRechnung missing <Invoice> root"
fi

# ───── 6. Deep check: parse embedded factur-x.xml ─────
echo
note "=== 5. deep validation: embedded factur-x.xml ==="
# Use python to extract + parse the embedded XML.
# This is the canonical E-Invoice test — pypdf is the
# reference implementation for Factur-X / ZUGFeRD
# validation in the Python ecosystem.
python3 - <<PYEOF > "$TMPDIR/parse.txt" 2>&1
import sys
try:
    from pypdf import PdfReader
except ImportError:
    print("PYPDF_MISSING")
    sys.exit(0)
r = PdfReader("$DEFAULT_PDF")
names = r.trailer['/Root']['/Names']['/EmbeddedFiles']['/Names']
ref = names[1].get_object()
data = ref['/EF']['/F'].get_object().get_data().decode('utf-8')
checks = {
  "has CrossIndustryInvoice root": "<rsm:CrossIndustryInvoice" in data,
  "has EN16931 guideline":         "urn:cen.eu:en16931:2017" in data,
  "has Factur-X name":             "Factur-X" in data,
  "has supplier name":             "SH Leder" in data,
  "has issue date":                "<ram:IssueDate>" in data,
  "has invoice number":            "INV-2026" in data,
  "AFRelationship = Source":       names[1].get_object().get('/AFRelationship') == '/Source',
}
for k, v in checks.items():
    print(f"{'✓' if v else '✗'} {k}")
PYEOF
cat "$TMPDIR/parse.txt"
while IFS= read -r line; do
  case "$line" in
    *"PYPDF_MISSING"*)
      pass "pypdf not available — skipping deep parse (skip rest of deep checks)"
      break
      ;;
    *"✓"*)
      pass "$(echo "$line" | sed 's/^✓ //')"
      ;;
    *"✗"*)
      fail "$(echo "$line" | sed 's/^✗ //')"
      ;;
  esac
done

# ───── 7. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Payment"          WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%'
);
DELETE FROM "InvoiceItem"      WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%'
);
DELETE FROM "Invoice"          WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier60-%';
SQL
pass "cleanup complete"

rm -rf "$TMPDIR"

summary
exit $?
