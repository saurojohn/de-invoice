#!/usr/bin/env bash
# e2e 61: Tier 29 + Tier 31 + Tier 34 + Tier 35 — OCR pipeline.
#
# Verifies the OCR pipeline:
#   1. GET /api/v1/ocr/fixture returns the hard-coded
#      German receipt fixture (used as the dev/test
#      sample so we don't depend on a real OCR
#      provider or uploaded image).
#   2. GET /api/v1/ocr/extract?text=... returns the
#      regex extractors applied to arbitrary text
#      (this is the pure-function smoke test the
#      dev uses to debug "what would the extractor
#      return for this weird OCR output?").
#   3. POST /api/v1/ocr/match-supplier with a
#      brand-new VAT-ID + name → creates a new
#      Supplier, returns {created: true}.
#   4. POST /api/v1/ocr/match-supplier with the
#      SAME VAT-ID → reuses the same supplier,
#      returns {created: false, matchedBy: vatId}.
#   5. POST /api/v1/ocr/scan with a multipart file
#      upload → returns the receipt (mock: same
#      fixture every time. tesseract: real OCR
#      on the upload).
#   6. POST /api/v1/ocr/scan without a file → 400
#      (file is required).
#   7. POST /api/v1/ocr/scan with the bundled
#      real German receipt PNG — only runs when
#      OCR_ENGINE=tesseract is set. Validates that
#      the real OCR path extracts supplier / invoice
#      number / date / net / gross correctly.
#   8. Tier 34: POST /api/v1/ocr/scan with the
#      bundled real German invoice PDF — verifies
#      that pdfjs-dist extracts text-layer fields.
#      Runs in tesseract mode (mock ignores the file
#      content the same way it does for PNGs).
#   9. Tier 35: POST /api/v1/ocr/scan with the
#      bundled SCANNED PDF (image-only, no text
#      layer) — verifies the rasterize-and-OCR
#      fallback path. Runs in tesseract mode only.
#
# The frontend flow is:
#   1. User uploads a scan → /ocr/scan returns
#      ReceiptData
#   2. Frontend edits fields, then calls
#      /ocr/match-supplier with the OCR'd
#      VAT-ID+name to get a supplierId
#   3. Frontend POSTs the regular /expenses with
#      the prefill + supplierId
#
# This test covers steps 1, 2, and 2-of-step-3
# (match-supplier). The final step-3 wiring
# (Expense create from prefill) goes through
# the existing /api/v1/expenses endpoint — covered
# by the older e2e 12.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# ---- 1. Fixture endpoint ----
echo "=== 1. GET /ocr/fixture returns hard-coded receipt ==="
api_get "/api/v1/ocr/fixture"
echo "$BODY" > /tmp/t61_fixture.json
FIX_GROSS=$(echo "$BODY" | jq -r '.grossAmount')
FIX_VATID=$(echo "$BODY" | jq -r '.supplierVatId')
FIX_NAME=$(echo "$BODY" | jq -r '.supplierName')
FIX_INVNUM=$(echo "$BODY" | jq -r '.invoiceNumber')
assert_eq "fixture grossAmount = 119" "$FIX_GROSS" "119"
assert_eq "fixture supplierVatId" "$FIX_VATID" "DE123456789"
assert_eq "fixture supplierName" "$FIX_NAME" "Musterfirma GmbH"
assert_eq "fixture invoiceNumber" "$FIX_INVNUM" "RG-2026-0042"

# ---- 2. Regex extractors via /ocr/extract ----
echo
echo "=== 2. GET /ocr/extract?text=... runs regex over input ==="
# Build a malformed variant — extra whitespace,
# uppercase labels, weird decimal format — to
# prove the regex tolerates real OCR noise.
TEXT=$'MUSTERFIRMA GMBH\nMUSTERSTR. 1, 12345 BERLIN\nUST-IDNR DE123456789\n\nRECHNUNG NR.   RG-2026-0099\nDATUM:  15.06.2026\n\nZWISCHENSUMME NETTO:    200,00 EUR\nUST 19%:      38,00 EUR\nGESAMTBETRAG:  238,00 EUR\n\nIBAN: DE89 3704 0044 0532 0130 00\nBIC: COBADEFFXXX'
ENCODED=$(printf '%s' "$TEXT" | python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.stdin.read()))")
api_get "/api/v1/ocr/extract?text=$ENCODED"
echo "$BODY" > /tmp/t61_extract.json
EX_GROSS=$(echo "$BODY" | jq -r '.grossAmount')
EX_VATID=$(echo "$BODY" | jq -r '.supplierVatId')
EX_NAME=$(echo "$BODY" | jq -r '.supplierName')
EX_VAT=$(echo "$BODY" | jq -r '.vatRate')
EX_INVNUM=$(echo "$BODY" | jq -r '.invoiceNumber')
assert_eq "extract grossAmount" "$EX_GROSS" "238"
assert_eq "extract supplierVatId" "$EX_VATID" "DE123456789"
assert_eq "extract supplierName" "$EX_NAME" "MUSTERFIRMA GMBH"
assert_eq "extract vatRate" "$EX_VAT" "0.19"
assert_eq "extract invoiceNumber" "$EX_INVNUM" "RG-2026-0099"

# ---- 3. match-supplier creates new ----
echo
echo "=== 3. POST /ocr/match-supplier creates new Supplier ==="
# Use a unique VAT-ID so the test is idempotent.
UNIQUE_VATID="DE$(printf '%09d' "$RANDOM")"
SUPPLIER_NAME="OCR Test Supplier $RANDOM"
api_post "/api/v1/ocr/match-supplier?companyId=$COMPANY_ID" \
  "{\"vatId\":\"$UNIQUE_VATID\",\"name\":\"$SUPPLIER_NAME\"}"
echo "$BODY" > /tmp/t61_match1.json
MS_ID=$(echo "$BODY" | jq -r '.supplierId')
MS_CREATED=$(echo "$BODY" | jq -r '.created')
MS_BY=$(echo "$BODY" | jq -r '.matchedBy')
if [[ "$MS_CREATED" = "true" ]]; then pass "match new: created=true"; else fail "match new: created=$MS_CREATED"; fi
if [[ "$MS_BY" = "created" ]]; then pass "match new: matchedBy=created"; else fail "match new: matchedBy=$MS_BY"; fi
if [[ -z "$MS_ID" || "$MS_ID" = "null" ]]; then
  fail "match new: supplierId missing"
else
  pass "match new: supplierId=$MS_ID"
fi

# ---- 4. match-supplier reuses by VAT-ID ----
echo
echo "=== 4. POST /ocr/match-supplier reuses existing Supplier ==="
api_post "/api/v1/ocr/match-supplier?companyId=$COMPANY_ID" \
  "{\"vatId\":\"$UNIQUE_VATID\",\"name\":\"Different Name\"}"
echo "$BODY" > /tmp/t61_match2.json
MS2_ID=$(echo "$BODY" | jq -r '.supplierId')
MS2_CREATED=$(echo "$BODY" | jq -r '.created')
MS2_BY=$(echo "$BODY" | jq -r '.matchedBy')
assert_eq "match reuse: same supplierId" "$MS2_ID" "$MS_ID"
if [[ "$MS2_CREATED" = "false" ]]; then pass "match reuse: created=false"; else fail "match reuse: created=$MS2_CREATED"; fi
if [[ "$MS2_BY" = "vatId" ]]; then pass "match reuse: matchedBy=vatId"; else fail "match reuse: matchedBy=$MS2_BY"; fi

# ---- 5. /ocr/scan with multipart file upload (mock only) ----
# Block 5 verifies that the controller wires up
# the FileInterceptor + pipes the buffer into
# the OCR engine. We use a fake PNG because the
# mock service ignores bytes. In tesseract mode
# the fake PNG would crash the worker — block 7
# covers the real OCR path with a valid PNG.
echo
echo "=== 5. POST /ocr/scan (multipart upload) returns fixture (mock only) ==="
if [[ "${OCR_ENGINE:-mock}" != "tesseract" ]]; then
  # Build a tiny PNG-ish blob. We don't need a valid
  # PNG — the v1 mock ignores the bytes. The
  # FileInterceptor only runs mimetype + size checks.
  TMP_IMG=$(mktemp -t t61_scan.XXXXXX.png)
  printf '\x89PNG\r\n\x1a\nfake-png-bytes' > "$TMP_IMG"
  SCAN_STATUS=$(curl -sS -o /tmp/t61_scan.json -w "%{http_code}" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID" \
    -F "file=@$TMP_IMG;type=image/png")
  assert_eq "scan returns 201" "$SCAN_STATUS" "201"
  SCAN_GROSS=$(jq -r '.grossAmount' /tmp/t61_scan.json)
  assert_eq "scan grossAmount from fixture" "$SCAN_GROSS" "119"
  SCAN_INV=$(jq -r '.invoiceNumber' /tmp/t61_scan.json)
  assert_eq "scan invoiceNumber from fixture" "$SCAN_INV" "RG-2026-0042"
  mavis-trash "$TMP_IMG"
else
  echo "  ⏭  skipped — OCR_ENGINE=tesseract (block 7 covers real OCR)"
fi

# ---- 7. Real OCR (tesseract.js) on bundled German receipt ----
# Only runs when OCR_ENGINE=tesseract. The mock path
# would return the fixture regardless of bytes, which
# we already covered in block 5 — we don't want to
# duplicate that here.
echo
echo "=== 7. Real OCR scan on bundled german-receipt.png (tesseract only) ==="
if [[ "${OCR_ENGINE:-mock}" != "tesseract" ]]; then
  echo "  ⏭  skipped — OCR_ENGINE=${OCR_ENGINE:-mock} (set OCR_ENGINE=tesseract to enable)"
else
  REAL_IMG="$(dirname "$0")/fixtures/german-receipt.png"
  if [[ ! -f "$REAL_IMG" ]]; then
    fail "real OCR: missing fixture $REAL_IMG"
  else
    REAL_STATUS=$(curl -sS -o /tmp/t61_real.json -w "%{http_code}" \
      -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
      -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID" \
      -F "file=@$REAL_IMG;type=image/png")
    assert_eq "real OCR scan returns 201" "$REAL_STATUS" "201"
    REAL_SUP=$(jq -r '.supplierName' /tmp/t61_real.json)
    REAL_INV=$(jq -r '.invoiceNumber' /tmp/t61_real.json)
    REAL_DATE=$(jq -r '.invoiceDate' /tmp/t61_real.json)
    REAL_NET=$(jq -r '.netAmount' /tmp/t61_real.json)
    REAL_GROSS=$(jq -r '.grossAmount' /tmp/t61_real.json)
    # tesseract may drop the "Musterfirma GmbH" trailing
    # newline so we use `contains` style assertions —
    # match the prefix that the OCR engine reliably sees.
    if [[ "$REAL_SUP" == Musterfirma* ]]; then
      pass "real OCR: supplier=$REAL_SUP"
    else
      fail "real OCR: supplier=$REAL_SUP (expected Musterfirma*)"
    fi
    assert_eq "real OCR: invoiceNumber" "$REAL_INV" "RG-2026-0042"
    assert_eq "real OCR: invoiceDate" "$REAL_DATE" "28.06.2026"
    assert_eq "real OCR: netAmount" "$REAL_NET" "100"
    assert_eq "real OCR: grossAmount" "$REAL_GROSS" "119"
  fi
fi

# ---- 6. /ocr/scan without file → 400 ----
echo
echo "=== 6. POST /ocr/scan without file → 400 ==="
SCAN_NO_FILE_STATUS=$(curl -sS -o /tmp/t61_no_file.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID")
assert_eq "scan without file returns 400" "$SCAN_NO_FILE_STATUS" "400"

# ---- 8. Tier 34: PDF scan via pdfjs-dist (real text layer extraction) ----
echo
echo "=== 8. PDF scan on bundled german-invoice.pdf (tesseract only) ==="
# Tier 34: in real-OCR mode, the controller delegates
# PDF uploads to pdfjs-dist instead of tesseract.js.
# The bundled fixture is a digital PDF with a real
# text layer (the same structure as a Word/Acrobat
# export). We assert that the extracted fields match
# what the document actually contains.
#
# Note: the mock OCR engine also passes this through
# (mock returns the fixture regardless of bytes), but
# the fixture text is the same supplier / number /
# amounts so the assertions still hold in mock mode
# — they're not engine-specific. We run the block
# unconditionally to cover both envs.
PDF_FILE="$(dirname "$0")/fixtures/german-invoice.pdf"
if [[ ! -f "$PDF_FILE" ]]; then
  fail "PDF real OCR: missing fixture $PDF_FILE"
else
  PDF_STATUS=$(curl -sS -o /tmp/t61_pdf.json -w "%{http_code}" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID" \
    -F "file=@$PDF_FILE;type=application/pdf")
  assert_eq "PDF scan returns 201" "$PDF_STATUS" "201"
  PDF_SOURCE=$(jq -r '._source' /tmp/t61_pdf.json)
  PDF_SUP=$(jq -r '.supplierName' /tmp/t61_pdf.json)
  PDF_VAT=$(jq -r '.supplierVatId' /tmp/t61_pdf.json)
  PDF_INV=$(jq -r '.invoiceNumber' /tmp/t61_pdf.json)
  PDF_NET=$(jq -r '.netAmount' /tmp/t61_pdf.json)
  PDF_GROSS=$(jq -r '.grossAmount' /tmp/t61_pdf.json)
  # In tesseract mode the _source field comes back
  # as 'pdf' (Tier 34 detection via magic bytes). In
  # mock mode the field is absent (we only emit it
  # when NODE_ENV !== 'production').
  if [[ "${OCR_ENGINE:-mock}" == "tesseract" ]]; then
    assert_eq "PDF source tag (_source)" "$PDF_SOURCE" "pdf"
  fi
  # The PDF fixture text matches the OCR fixture, so
  # both engines return the same fields. Only tesseract
  # mode actually parses the PDF (mock returns the
  # fixture; a fresh re-run of block 5 would return
  # the same values either way).
  assert_eq "PDF: supplier" "$PDF_SUP" "Musterfirma GmbH"
  assert_eq "PDF: supplierVatId" "$PDF_VAT" "DE123456789"
  assert_eq "PDF: invoiceNumber" "$PDF_INV" "RG-2026-0042"
  assert_eq "PDF: netAmount" "$PDF_NET" "100"
  assert_eq "PDF: grossAmount" "$PDF_GROSS" "119"
fi

# ---- 9. Tier 35: scanned PDF (no text layer) rasterize + tesseract OCR ----
echo
echo "=== 9. Scanned PDF scan on bundled scanned-invoice.pdf (tesseract only) ==="
if [[ "${OCR_ENGINE:-mock}" != "tesseract" ]]; then
  echo "  ⏭  skipped — OCR_ENGINE=${OCR_ENGINE:-mock} (set OCR_ENGINE=tesseract to enable)"
else
  SCAN_PDF_FILE="$(dirname "$0")/fixtures/scanned-invoice.pdf"
  if [[ ! -f "$SCAN_PDF_FILE" ]]; then
    fail "scanned PDF real OCR: missing fixture $SCAN_PDF_FILE"
  else
    SCAN_PDF_STATUS=$(curl -sS -o /tmp/t61_scan_pdf.json -w "%{http_code}" \
      -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
      -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID" \
      -F "file=@$SCAN_PDF_FILE;type=application/pdf")
    assert_eq "scanned PDF returns 201" "$SCAN_PDF_STATUS" "201"
    SCAN_PDF_SOURCE=$(jq -r '._source' /tmp/t61_scan_pdf.json)
    SCAN_PDF_SUP=$(jq -r '.supplierName' /tmp/t61_scan_pdf.json)
    SCAN_PDF_INV=$(jq -r '.invoiceNumber' /tmp/t61_scan_pdf.json)
    SCAN_PDF_DATE=$(jq -r '.invoiceDate' /tmp/t61_scan_pdf.json)
    SCAN_PDF_NET=$(jq -r '.netAmount' /tmp/t61_scan_pdf.json)
    SCAN_PDF_GROSS=$(jq -r '.grossAmount' /tmp/t61_scan_pdf.json)
    # _source must be 'pdf-raster' (NOT 'pdf'). This is
    # what proves we hit the Tier 35 fallback path —
    # tier34's text-extraction would have a real text
    # layer (this fixture has none).
    assert_eq "scanned PDF: _source = pdf-raster" "$SCAN_PDF_SOURCE" "pdf-raster"
    if [[ "$SCAN_PDF_SUP" == Musterfirma* ]]; then
      pass "scanned PDF: supplier=$SCAN_PDF_SUP"
    else
      fail "scanned PDF: supplier=$SCAN_PDF_SUP (expected Musterfirma*)"
    fi
    assert_eq "scanned PDF: invoiceNumber" "$SCAN_PDF_INV" "RG-2026-0042"
    assert_eq "scanned PDF: invoiceDate" "$SCAN_PDF_DATE" "28.06.2026"
    assert_eq "scanned PDF: netAmount" "$SCAN_PDF_NET" "100"
    assert_eq "scanned PDF: grossAmount" "$SCAN_PDF_GROSS" "119"
  fi
fi

# ---- Cleanup ----
mavis-trash /tmp/t61_fixture.json /tmp/t61_extract.json /tmp/t61_match1.json /tmp/t61_match2.json /tmp/t61_scan.json /tmp/t61_no_file.json /tmp/t61_real.json /tmp/t61_pdf.json /tmp/t61_scan_pdf.json 2>/dev/null

if [[ $FAILS -gt 0 ]]; then
  echo
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
echo "ALL PASSED"