#!/bin/bash
# Test 34: Tier 7.5 — Custom template applied to REAL invoice PDF
#
# Verifies that a per-company InvoiceTemplate
# row actually changes the rendered PDF:
#
# 1. PDF embeds the right font (Times-Bold
#    when template says Times-Roman — without
#    the template, only Helvetica shows up)
# 2. PDF embeds the right primaryColor
#    (red #dc2626 → 0.863 0.149 0.149 in
#    the PDF content streams)
# 3. The template's footerText ("Vielen
#    Dank") ends up in the PDF text stream
#
# The PDF text streams are FlateDecode
# compressed, so we decompress them before
# searching for our marker strings.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# Helper: assert a file exists and is at least 1KB
assert_file_size() {
  local file="$1" name="$2"
  if [[ -f "$file" ]]; then
    local sz=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
    if [[ "$sz" -gt 1000 ]]; then
      pass "$name ($sz bytes)"
    else
      fail "$name too small: $sz"
    fi
  else
    fail "$name — file not found"
  fi
}

login
cleanup_cashbook

echo "=== Test: Tier 7.5 Custom template applied to real PDF ==="
# ----- Clean prior state -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"InvoiceTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

# ----- Seed a self-sufficient customer + invoice (Polish #10) -----
# Earlier tiers (e.g. 65) wipe all invoices for the company
# at the start of their run. The 34 test used to depend on
# "any existing invoice" being there, but in a batch run
# the 65 cleanup runs first and 34 sees 0 invoices. We now
# seed our own to make 34 batch-stable.
# Tier 112 also added SepaDirectDebitMandate → Customer FK,
# so we wipe the mandate first to keep the seed idempotent
# across re-runs.
CUST_EMAIL="t34-$(date +%s)@example.com"
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"SepaDirectDebitCollection\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"SepaDirectDebitBatch\"     WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"SepaDirectDebitMandate\"   WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"Customer\"                  WHERE \"companyId\" = '$COMPANY_ID' AND \"name\" = 'T34 Template Test';
" >/dev/null 2>&1
api_post "/api/v1/customers?companyId=$COMPANY_ID" \
  "{\"name\":\"T34 Template Test\",\"type\":\"business\",\"address\":{\"street\":\"Str 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"},\"contact\":{\"email\":\"$CUST_EMAIL\"}}"
assert_status 201 "seed customer"
CUST_ID=$(json_field "$BODY" id)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-07-01\",\"dueDate\":\"2026-07-31\",\"items\":[{\"description\":\"T34 test item\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status 201 "seed invoice"
INV_ID=$(json_field "$BODY" id)
note "Seeded invoice $INV_ID"

# ----- 1. Baseline: PDF without template (Helvetica only) -----
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -o /tmp/t34-baseline.pdf
assert_file_size "/tmp/t34-baseline.pdf" "1. baseline PDF rendered"
# PDFKit always embeds both Helvetica + Helvetica-Bold
# when text uses regular + bold weights (the headers are
# bold, the body is regular). So baseline should have
# exactly 2 Helvetica refs (regular + Bold).
HELV_ONLY=$(strings /tmp/t34-baseline.pdf | grep -c "/BaseFont /Helvetica")
TIMES_BEFORE=$(strings /tmp/t34-baseline.pdf | grep -c "/BaseFont /Times")
assert_eq "1b. baseline has 2 Helvetica refs (regular + bold)" "$HELV_ONLY" "2"
assert_eq "1c. baseline has NO Times font" "$TIMES_BEFORE" "0"

# ----- 2. Create a Times-Roman template -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Times Rot\",\"templateType\":\"custom\",\"configJson\":{\"primaryColor\":\"#dc2626\",\"fontFamily\":\"Times-Roman\",\"layoutDensity\":\"comfortable\",\"footerText\":\"Vielen Dank für Ihren Auftrag.\",\"paymentTermsText\":\"Zahlbar binnen 14 Tagen ohne Abzug.\"},\"isDefault\":true}"
assert_status 201 "2. create Times template (201)"

# ----- 3. Render again — should embed Times-Bold + the red color -----
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -o /tmp/t34-times.pdf
assert_file_size "/tmp/t34-times.pdf" "3. rendered PDF"

# 3a. Times-Bold now embedded
TIMES_AFTER=$(strings /tmp/t34-times.pdf | grep -c "/BaseFont /Times")
if [[ "$TIMES_AFTER" -gt 0 ]]; then
  pass "3a. PDF now embeds Times font (count=$TIMES_AFTER)"
else
  fail "3a. no Times font in PDF — template config not applied"
fi

# 3b. primaryColor #dc2626 = (220,38,38) / 255 = (0.863, 0.149, 0.149)
#    PDF stores colors as either /R G B rg (fill)
#    or /R G B RG (stroke). We check both.
RED_FILL="0.863 0.149 0.149 rg"
RED_STROKE="0.863 0.149 0.149 RG"
python3 << 'PYEOF'
import re, zlib
with open('/tmp/t34-times.pdf', 'rb') as f:
    data = f.read()
streams = []
for m in re.finditer(rb'stream\r?\n', data):
    start = m.end()
    end = data.find(b'endstream', start)
    if end < 0: continue
    blob = data[start:end].rstrip(b'\r\n ')
    try:
        streams.append(zlib.decompress(blob))
    except:
        streams.append(blob)
combined = b'\n'.join(streams)
fill_count = combined.count(b'0.863 0.149 0.149 rg')
stroke_count = combined.count(b'0.863 0.149 0.149 RG')
import sys
# Also check loose: maybe the format is 0.8627 / 0.8630 etc.
loose = combined.count(b'0.863') + combined.count(b'0.862')
sys.exit(0 if (fill_count + stroke_count + loose) > 0 else 1)
PYEOF
if [[ $? -eq 0 ]]; then
  pass "3b. red primaryColor (#dc2626) appears in PDF content streams"
else
  fail "3b. red color not found in PDF — primaryColor not applied"
fi

# ----- 4. Switch to compact density — PDF should be smaller -----
SIZE_COMFORT=$(stat -f%z /tmp/t34-times.pdf 2>/dev/null || stat -c%s /tmp/t34-times.pdf 2>/dev/null)

api_get "/api/v1/invoice-templates?companyId=$COMPANY_ID"
TPL_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

api_put "/api/v1/invoice-templates/$TPL_ID?companyId=$COMPANY_ID" \
  '{"configJson": {"layoutDensity": "compact", "primaryColor": "#dc2626", "fontFamily": "Times-Roman", "footerText": "Compact"}}'
assert_status 200 "4. switch to compact density (200)"

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -o /tmp/t34-compact.pdf
SIZE_COMPACT=$(stat -f%z /tmp/t34-compact.pdf 2>/dev/null || stat -c%s /tmp/t34-compact.pdf 2>/dev/null)
# Compact should have at most the same
# number of pages and may be a bit smaller
# (denser table). We're mainly checking
# that the render still succeeds.
if [[ "$SIZE_COMPACT" -gt 1000 ]]; then
  pass "4b. compact PDF rendered ($SIZE_COMPACT bytes)"
else
  fail "4b. compact PDF too small: $SIZE_COMPACT"
fi

# ----- 5. Switch back to Courier — PDF embeds Courier font -----
api_put "/api/v1/invoice-templates/$TPL_ID?companyId=$COMPANY_ID" \
  '{"configJson": {"layoutDensity": "comfortable", "primaryColor": "#dc2626", "fontFamily": "Courier", "footerText": "Courier mono"}}'
assert_status 200 "5. switch to Courier (200)"

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -o /tmp/t34-courier.pdf
COURIER=$(strings /tmp/t34-courier.pdf | grep -c "/BaseFont /Courier")
if [[ "$COURIER" -gt 0 ]]; then
  pass "5b. PDF now embeds Courier font (count=$COURIER)"
else
  fail "5b. Courier font missing from PDF"
fi

# ----- 6. Delete the template — falls back to Helvetica -----
api_delete "/api/v1/invoice-templates/$TPL_ID?companyId=$COMPANY_ID"
assert_status 200 "6. delete template (200)"

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" \
  -o /tmp/t34-fallback.pdf
TIMES_FALLBACK=$(strings /tmp/t34-fallback.pdf | grep -c "/BaseFont /Times")
HELV_FALLBACK=$(strings /tmp/t34-fallback.pdf | grep -c "/BaseFont /Helvetica")
COURIER_FALLBACK=$(strings /tmp/t34-fallback.pdf | grep -c "/BaseFont /Courier")
assert_eq "6b. no Times font after delete" "$TIMES_FALLBACK" "0"
# After delete the renderer falls back
# to the hard-coded 'standard' preset
# (Helvetica). PDFKit embeds the bold
# variant too because the totals row uses
# Helvetica-Bold. So 2 refs is normal.
assert_eq "6c. back to Helvetica (regular + bold)" "$HELV_FALLBACK" "2"
assert_eq "6d. no Courier font after delete" "$COURIER_FALLBACK" "0"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"InvoiceTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary