#!/bin/bash
# Test 27: Tier 5.7 — DATEV-Beleg-Paket (zip with CSV + PDFs)
#
# Verifies the new /reports/datev-export-bundle
# endpoint. The response is a zip archive that
# contains:
#   - Buchungsstapel.csv (the same CSV as
#     /reports/datev-export)
#   - Belegbilder/<invoiceNumber>.pdf — one per
#     Invoice that has a pdfPath
#   - Belegbilder/index.json — audit trail of which
#     PDF came from where
#   - MANIFEST.json — generatedAt + counts
#
# The test seeds an Invoice with a known PDF path
# and a fake PDF on disk, then fetches the bundle
# and asserts:
#   1. HTTP 200 + Content-Type: application/zip
#   2. Filename has the same L<laufNr> pattern as CSV
#   3. The zip contains the expected files
#   4. The CSV in the zip has the invoice's data
#   5. The matching PDF is present in Belegbilder/
#   6. The MANIFEST.json + index.json are valid JSON
#   7. Missing PDFs (path set but file deleted) are
#      skipped silently (no 500)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5.7 DATEV-Beleg-Paket ==="

# Seed: an Invoice with a real PDF on disk.
# We pick a date in 2026 (matches the existing test
# data range), a customer, a payment, and a fake
# PDF at the path the storage service expects.
COMPANY_ID_CID="ad257ec3-d319-479b-b870-3fe76e8f3111"
INV_ID="e2e0e0e0-0001-0000-0007-000000000027"
INV_NO="E2E-T7-BUNDLE-01"
PAY_ID="e2e0e0e0-0001-0000-0007-000000000028"
CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'E2E T5 DE Customer' LIMIT 1;" 2>/dev/null | tr -d ' ')
# Tier 299 fix: the original spec used customerNumber
# 'K-T7' but that slot is now owned by the Tier 8
# bank-import Müller GmbH fixture (per Round 11-34
# fixture-survival rule). The INSERT into Customer
# hit a unique-key violation, the customer never
# got created, the follow-up SELECT returned empty,
# and the spec's Invoice INSERT silently failed
# (the FK column accepted '' as a no-op on some
# PG versions but rejected on others). The bundle
# then had nothing to BelegBild.
# Fix: use a Tier-27 prefixed customer number that
# no other tier script shares, AND a fresh name,
# so the lookup-after-insert actually finds the row.
if [[ -z "$CUST_ID" ]]; then
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
    INSERT INTO \"Customer\" (id, \"companyId\", name, \"customerNumber\", address, \"createdAt\", \"updatedAt\")
    VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'E2E T7 Bundle Cust', 'K-T7BUNDLE',
            '{\"country\":\"DE\"}'::jsonb, now(), now());" >/dev/null 2>&1
  CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND \"customerNumber\" = 'K-T7BUNDLE' LIMIT 1;" 2>/dev/null | tr -d ' ')
fi
# If the lookup-after-insert still came back empty
# (because the dev DB already had a Customer named
# 'E2E T7 Bundle Cust' from a prior run with a
# different customerNumber — that Customer is still
# usable for this spec), fall back to any Customer
# for the test company so the Invoice INSERT has a
# valid FK.
if [[ -z "$CUST_ID" ]]; then
  CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')
  note "Tier 299: reused existing customer $CUST_ID for E2E-T7-BUNDLE-01 (no fresh insert needed)"
fi

# Clean up any prior run
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id = '$PAY_ID';
  DELETE FROM \"Invoice\" WHERE id = '$INV_ID';" >/dev/null 2>&1

# Create the Invoice with pdfPath pointing to a
# real (fake) PDF on disk. The path mirrors what
# the storage service would write:
#   <localPath>/<year>/<month>/pdf/<companyId>/<ts>_<invNo>.pdf
# Tier 332: use $STORAGE_PATH (set by the CI job
# to /tmp/de-invoice-storage) instead of the
# hardcoded /Users/shledergmbh/data/invoice-system
# path. The hardcoded path is the dev's local
# machine, which doesn't exist on the Ubuntu
# runner — `mkdir -p` would happily create it
# (root can write anywhere) but the subsequent
# zip-bundle step reads the PDF back from the
# same hardcoded path, and on a fresh runner
# the path is in a different filesystem layer.
# Fall back to a tmpdir under /tmp if the env
# var is unset so the spec still works locally.
STORAGE_BASE="${STORAGE_PATH:-/tmp/de-invoice-storage}"
PDF_REL_PATH="2026/05/pdf/$COMPANY_ID/1780300000000_${INV_NO}.pdf"
PDF_ABS_PATH="$STORAGE_BASE/$PDF_REL_PATH"
mkdir -p "$(dirname "$PDF_ABS_PATH")"
# Minimal valid PDF (5 bytes header + tiny trailer
# is enough for zip / file_exists checks; the bundle
# doesn't parse the PDF — it just streams it).
printf '%%PDF-1.4\n%%fake E2E PDF for %s\n%%%%EOF\n' "$INV_NO" > "$PDF_ABS_PATH"

docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceNumber\",
                          type, status, \"issueDate\", \"dueDate\",
                          subtotal, \"totalVat\", total, currency, language, \"vatBreakdown\",
                          \"reverseCharge\", \"euTransaction\",
                          notes, \"templateType\", \"pdfPath\", attachments, \"createdAt\", \"updatedAt\")
  VALUES ('$INV_ID', '$COMPANY_ID', '$CUST_ID', '$INV_NO', 9701,
          'INV', 'paid', '2026-05-15', '2026-06-15',
          100.00, 19.00, 119.00, 'EUR', 'de-DE', '[]',
          false, false,
          'E2E bundle', 'standard', '$PDF_REL_PATH', '[]', now(), now());
  INSERT INTO \"Payment\" (id, \"invoiceId\", amount, currency, \"paymentDate\", \"paymentMethod\", \"createdAt\")
  VALUES ('$PAY_ID', '$INV_ID', 119.00, 'EUR', '2026-05-20', 'bank_transfer', now());
" >/dev/null 2>&1

# ===== Fetch the bundle =====
# Use laufNr=2 so the filename suffix differs from
# the default "L001" (we want to confirm the suffix
# roundtrip works).
docker exec -e PGPASSWORD=de_invoice_pass "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\"
  SET settings = jsonb_build_object(
    'datev', jsonb_build_object(
      'laufNr', jsonb_build_object('2026', 2)
    )
  )
  WHERE id = '$COMPANY_ID';" >/dev/null 2>&1

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -D /tmp/bundle-hdr.txt -o /tmp/bundle.zip

# HTTP 200
STATUS=$(head -1 /tmp/bundle-hdr.txt | awk '{print $2}')
assert_eq "HTTP 200" "$STATUS" "200"

# Content-Type zip (it's usually around line 11+
# in the Express response, so check the whole file)
if LC_ALL=C grep -qi "Content-Type: application/zip" /tmp/bundle-hdr.txt; then
  pass "Content-Type: application/zip"
else
  fail "Content-Type missing or wrong"
  cat /tmp/bundle-hdr.txt
fi

# Filename has L002 (laufNr 2 from above)
if LC_ALL=C grep -qi 'filename="EXTF_Buchungsstapel_2026-01-01_L002.zip"' /tmp/bundle-hdr.txt; then
  pass "filename uses laufNr 2: L002.zip"
else
  fail "filename pattern wrong (expect L002.zip)"
  LC_ALL=C grep -i "filename" /tmp/bundle-hdr.txt
fi

# Valid zip file
FILE_TYPE=$(file -b /tmp/bundle.zip)
if [[ "$FILE_TYPE" == Zip* ]]; then
  pass "valid zip archive"
else
  fail "not a zip: $FILE_TYPE"
fi

# Has the expected entries
COUNT_PRESENT=$(unzip -l /tmp/bundle.zip 2>/dev/null | grep -F -c "Buchungsstapel.csv")
  if [[ "$COUNT_PRESENT" -gt 0 ]]; then
  pass "Buchungsstapel.csv present"
else
  fail "Buchungsstapel.csv missing"
fi

COUNT_PRESENT=$(unzip -l /tmp/bundle.zip 2>/dev/null | grep -F -c "Belegbilder/${INV_NO}.pdf")
  if [[ "$COUNT_PRESENT" -gt 0 ]]; then
  pass "Belegbilder/${INV_NO}.pdf present"
else
  fail "Belegbilder/${INV_NO}.pdf missing"
  unzip -l /tmp/bundle.zip | grep -E "Belegbilder|E2E-T7" | head -3
fi

COUNT_PRESENT=$(unzip -l /tmp/bundle.zip 2>/dev/null | grep -F -c "Belegbilder/index.json")
  if [[ "$COUNT_PRESENT" -gt 0 ]]; then
  pass "Belegbilder/index.json present"
else
  fail "Belegbilder/index.json missing"
fi

COUNT_PRESENT=$(unzip -l /tmp/bundle.zip 2>/dev/null | grep -F -c "MANIFEST.json")
  if [[ "$COUNT_PRESENT" -gt 0 ]]; then
  pass "MANIFEST.json present"
else
  fail "MANIFEST.json missing"
fi

# Extract the CSV and check it contains our invoice
unzip -p /tmp/bundle.zip Buchungsstapel.csv > /tmp/bundle-csv.csv
if LC_ALL=C grep -q "$INV_NO" /tmp/bundle-csv.csv; then
  pass "CSV in bundle contains $INV_NO"
else
  fail "CSV in bundle missing $INV_NO"
fi

# Extract the PDF and verify it's a real PDF (not
# just a fake file). The bytes-start-with-%PDF check
# is the most basic content sanity.
unzip -p /tmp/bundle.zip "Belegbilder/${INV_NO}.pdf" > /tmp/bundle-pdf.pdf
if head -c 5 /tmp/bundle-pdf.pdf | grep -q "%PDF-"; then
  pass "PDF in bundle starts with %PDF- magic"
else
  fail "PDF in bundle is not a real PDF"
  head -c 50 /tmp/bundle-pdf.pdf
fi

# Extract + parse index.json
unzip -p /tmp/bundle.zip Belegbilder/index.json > /tmp/bundle-idx.json
# index.json has one entry per Beleg-Bild. The
# test asserts (a) the file is valid JSON, (b)
# our test invoice is among the entries, (c)
# the count is at least 1 (it'll be more in
# practice because of the existing 2026 invoices).
IDX_HAS_INV=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-idx.json'))
print(any(e['belegfeld1'] == '$INV_NO' for e in d))
")
assert_eq "index.json has our invoice" "$IDX_HAS_INV" "True"
IDX_LEN=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-idx.json'))
print(len(d))
")
if [[ "$IDX_LEN" -ge 1 ]]; then
  pass "index.json has >= 1 entries (got: $IDX_LEN)"
else
  fail "index.json should have >= 1 entries, got: $IDX_LEN"
fi

# Extract + parse MANIFEST.json
unzip -p /tmp/bundle.zip MANIFEST.json > /tmp/bundle-manifest.json
MFG_BUCH=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-manifest.json'))
print(d['buchungsLauf'])
")
MFG_INC=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-manifest.json'))
print(d['belegbilderIncluded'])
")
assert_eq "MANIFEST buchungsLauf = 2" "$MFG_BUCH" "2"
# Same logic — the count includes all invoices
# in the system, not just our test one.
if [[ "$MFG_INC" -ge 1 ]]; then
  pass "MANIFEST belegbilderIncluded >= 1 (got: $MFG_INC)"
else
  fail "MANIFEST belegbilderIncluded should be >= 1, got: $MFG_INC"
fi

# ===== Missing PDF is silently skipped =====
# Delete the on-disk PDF, refetch, expect the
# invoice to still be in the CSV (Buchungsstapel
# unaffected) but no PDF in Belegbilder/ for it,
# and MANIFEST.belegbilderMissing >= 1.
rm -f "$PDF_ABS_PATH"

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle2.zip

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31")
assert_eq "missing PDF: HTTP 200 (no error)" "$STATUS" "200"

# CSV still has the invoice
unzip -p /tmp/bundle2.zip Buchungsstapel.csv > /tmp/bundle2-csv.csv
if LC_ALL=C grep -q "$INV_NO" /tmp/bundle2-csv.csv; then
  pass "missing PDF: CSV still has $INV_NO"
else
  fail "missing PDF: CSV lost $INV_NO"
fi

# PDF NOT in Belegbilder/ for this invoice
COUNT_PRESENT=$(unzip -l /tmp/bundle2.zip 2>/dev/null | grep -c "Belegbilder/${INV_NO}.pdf")
  if [[ "$COUNT_PRESENT" -gt 0 ]]; then
  fail "missing PDF: file still in zip (should be skipped)"
else
  pass "missing PDF: file NOT in zip (skipped)"
fi

# MANIFEST reports it as missing
unzip -p /tmp/bundle2.zip MANIFEST.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['belegbilderMissing'])
" > /tmp/missing.txt
MISS=$(cat /tmp/missing.txt)
if [[ "$MISS" -ge 1 ]]; then
  pass "MANIFEST reports belegbilderMissing >= 1 (got: $MISS)"
else
  fail "MANIFEST belegbilderMissing should be >= 1, got: $MISS"
fi

# Restore the PDF (in case other tests need it)
mkdir -p "$(dirname "$PDF_ABS_PATH")"
printf '%%PDF-1.4\n%%fake E2E PDF for %s\n%%%%EOF\n' "$INV_NO" > "$PDF_ABS_PATH"

# ----- Cleanup -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id = '$PAY_ID';
  DELETE FROM \"Invoice\" WHERE id = '$INV_ID';" >/dev/null 2>&1
rm -f "$PDF_ABS_PATH"
# Reset settings (only the laufNr we set above)
docker exec -e PGPASSWORD=de_invoice_pass "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\"
  SET settings = settings::jsonb #- '{datev,laufNr}'
  WHERE id = '$COMPANY_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
