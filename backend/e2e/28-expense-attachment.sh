#!/bin/bash
# Test 28: Tier 5.7b — Expense attachments in DATEV bundle
#
# Verifies the new wiring that the 1:N Attachment
# model is picked up by the DATEV-Beleg-Paket. The
# user uploads receipts via the ReceiptsPanel in
# the expenses page (POST /api/v1/attachments);
# those land as Attachment rows. The bundle needs
# to read them, walk each one's storage path, and
# zip the bytes in.
#
# Coverage:
#   1. Upload an attachment via /api/v1/attachments
#      for a fresh Expense → 201 + Attachment row
#   2. GET /api/v1/attachments lists it
#   3. GET the file bytes back, %PDF- magic intact
#   4. The DATEV bundle includes the file at
#      Belegbilder/<expenseNo>__<origName>.<ext>
#   5. The MANIFEST.belegbilderIncluded count
#      accounts for it
#   6. Multiple attachments on the same Expense
#      don't collide (suffix in filename)
#   7. Delete via /api/v1/attachments/:id removes
#      the file from the next bundle

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5.7b Expense attachments in DATEV bundle ==="

# ----- Fixed seed IDs -----
EXP_ID="e2e0e0e0-0001-0000-0007-0000000000a1"
SUPP_ID="e2e0e0e0-0001-0000-0007-0000000000a2"
EXP_NO="E2E-T7B-EXP-01"

# Clean up any prior run (idempotent re-runs)
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Attachment\" WHERE \"entityType\" = 'expense' AND \"entityId\" = '$EXP_ID';
  DELETE FROM \"Expense\" WHERE id = '$EXP_ID';
  DELETE FROM \"Supplier\" WHERE id = '$SUPP_ID';" >/dev/null 2>&1

# Create a Supplier (Expense needs one for the FK)
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Supplier\" (id, \"companyId\", name, address, \"createdAt\", \"updatedAt\")
  VALUES ('$SUPP_ID', '$COMPANY_ID', 'E2E T7B Supplier', '{\"country\":\"DE\"}'::jsonb, now(), now());
  INSERT INTO \"Expense\" (id, \"companyId\", \"supplierId\", \"invoiceNumber\", description, \"invoiceDate\",
                          \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\",
                          category, \"isIntraEU\", \"isReverseCharge\", status, notes,
                          \"createdAt\", \"updatedAt\")
  VALUES ('$EXP_ID', '$COMPANY_ID', '$SUPP_ID', '$EXP_NO', 'E2E bundle-attach',
          '2026-05-15', 100.00, 0.1900, 19.00, 119.00,
          'Material', false, false, 'booked', 'E2E',
          now(), now());" >/dev/null 2>&1

# ===== 1) Upload via /api/v1/attachments =====
# We use a FIXED filename ending in .pdf, not mktemp,
# because mktemp on macOS appends a random suffix AFTER
# the user-supplied name — so mktemp -t foo.XXXXXX.pdf
# produces "foo.XXXXXX.pdf.<random>" with the wrong
# extension, which the storage service rejects.
TMPF="/tmp/e2e-beleg-att.pdf"
cat > "$TMPF" <<'PDF'
%PDF-1.4
%fake E2E attachment test PDF
%%EOF
PDF
UPLOAD_RES=$(curl -sS -X POST -w "\n%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -F "file=@$TMPF" \
  -F "companyId=$COMPANY_ID" \
  -F "entityType=expense" \
  -F "entityId=$EXP_ID" \
  -F "uploadedById=$USER_ID" \
  "http://localhost:3001/api/v1/attachments")
STATUS=$(echo "$UPLOAD_RES" | tail -n1)
BODY=$(echo "$UPLOAD_RES" | sed '$d')
assert_status "201" "POST /attachments"
ATT_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
ATT_PATH=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['storagePath'])")
ATT_MIME=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['mimeType'])")
note "uploaded attachment id=$ATT_ID path=$ATT_PATH mime=$ATT_MIME"
rm -f "$TMPF"

# Verify Attachment row exists
ATT_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Attachment\" WHERE id = '$ATT_ID';
" 2>/dev/null | tr -d ' ')
assert_eq "Attachment row exists" "$ATT_COUNT" "1"

# ===== 2) GET /api/v1/attachments lists it =====
LIST_BODY=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/attachments?companyId=$COMPANY_ID&entityType=expense&entityId=$EXP_ID")
LIST_COUNT=$(echo "$LIST_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(len(d) if isinstance(d, list) else 0)
")
assert_eq "GET /attachments list count" "$LIST_COUNT" "1"

# ===== 3) GET the file bytes =====
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/attachments/$ATT_ID/file?companyId=$COMPANY_ID" \
  -o /tmp/e2e-att.pdf
if head -c 5 /tmp/e2e-att.pdf | grep -q "%PDF-"; then
  pass "attachment file bytes start with %PDF- magic"
else
  fail "attachment file is not a real PDF"
  head -c 50 /tmp/e2e-att.pdf
fi

# ===== 4) Bundle includes the attachment =====
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle-att.zip
unzip -l /tmp/bundle-att.zip | grep -F "Belegbilder/${EXP_NO}__" | head -5 > /tmp/bundle-entries.txt
if [[ -s /tmp/bundle-entries.txt ]]; then
  pass "bundle has Belegbilder/${EXP_NO}__* entry"
  cat /tmp/bundle-entries.txt
else
  fail "no Belegbilder/${EXP_NO}__* entry in bundle"
  unzip -l /tmp/bundle-att.zip | grep -E "Belegbilder" | head -5
fi

# Verify the file inside the zip is the same %PDF- content
PDF_NAME=$(unzip -l /tmp/bundle-att.zip | grep -oE "Belegbilder/${EXP_NO}__[a-zA-Z0-9_.-]+\.pdf" | head -1)
note "bundled entry: $PDF_NAME"
if [[ -n "$PDF_NAME" ]]; then
  unzip -p /tmp/bundle-att.zip "$PDF_NAME" 2>/dev/null > /tmp/bundle-att-pdf.pdf
  if head -c 5 /tmp/bundle-att-pdf.pdf | grep -q "%PDF-"; then
    pass "bundled attachment ($PDF_NAME) starts with %PDF- magic"
  else
    fail "bundled attachment is not a real PDF"
  fi
else
  fail "could not find bundled PDF in zip"
fi

# ===== 5) MANIFEST.belegbilderIncluded counts the new file =====
# The bundle includes all invoices + the new attachment,
# so we just check that the count is at least 2
# (existing invoices + this attachment). It can be much
# higher — we don't pin the count.
unzip -p /tmp/bundle-att.zip MANIFEST.json > /tmp/bundle-att-manifest.json
MFG_INC=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-att-manifest.json'))
print(d['belegbilderIncluded'])
")
if [[ "$MFG_INC" -ge 2 ]]; then
  pass "MANIFEST.belegbilderIncluded >= 2 (got: $MFG_INC)"
else
  fail "MANIFEST.belegbilderIncluded should be >= 2, got: $MFG_INC"
fi

# ===== 6) Multiple attachments on the same Expense =====
# Upload a second attachment
TMPF2="/tmp/e2e-beleg-att-2.pdf"
cat > "$TMPF2" <<'PDF'
%PDF-1.4
%second attachment
%%EOF
PDF
UPLOAD_RES2=$(curl -sS -X POST -w "\n%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -F "file=@$TMPF2" \
  -F "companyId=$COMPANY_ID" \
  -F "entityType=expense" \
  -F "entityId=$EXP_ID" \
  -F "uploadedById=$USER_ID" \
  "http://localhost:3001/api/v1/attachments")
STATUS2=$(echo "$UPLOAD_RES2" | tail -n1)
assert_status "201" "POST 2nd /attachments"
ATT_ID2=$(echo "$UPLOAD_RES2" | sed '$d' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
rm -f "$TMPF2"

# Re-fetch the bundle — should now have 2 entries
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle-att2.zip
COUNT_PRESENT=$(unzip -l /tmp/bundle-att2.zip 2>/dev/null | grep -F -c "Belegbilder/${EXP_NO}__")
assert_eq "bundle has 2 attachments for same Expense" "$COUNT_PRESENT" "2"

# ===== 7) Delete an attachment, bundle updates =====
DEL_STATUS=$(curl -sS -X DELETE -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/attachments/$ATT_ID?companyId=$COMPANY_ID")
assert_eq "DELETE /attachment returns 200" "$DEL_STATUS" "200"

# Verify the Attachment row is gone
ROW_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Attachment\" WHERE id = '$ATT_ID';
" 2>/dev/null | tr -d ' ')
assert_eq "deleted Attachment row gone" "$ROW_COUNT" "0"

# Re-fetch the bundle — should have 1 entry now
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle-att3.zip
COUNT_PRESENT=$(unzip -l /tmp/bundle-att3.zip 2>/dev/null | grep -F -c "Belegbilder/${EXP_NO}__")
assert_eq "bundle back to 1 attachment after delete" "$COUNT_PRESENT" "1"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Attachment\" WHERE \"entityType\" = 'expense' AND \"entityId\" = '$EXP_ID';
  DELETE FROM \"Expense\" WHERE id = '$EXP_ID';
  DELETE FROM \"Supplier\" WHERE id = '$SUPP_ID';" >/dev/null 2>&1
# Also clean up the second attachment's file on disk
ATT_PATH2=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"storagePath\" FROM \"Attachment\" WHERE id = '$ATT_ID2';" 2>/dev/null | tr -d ' ')
if [[ -n "$ATT_PATH2" ]]; then
  rm -f "/Users/shledergmbh/data/invoice-system/$ATT_PATH2"
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
    DELETE FROM \"Attachment\" WHERE id = '$ATT_ID2';" >/dev/null 2>&1
fi
note "Cleanup done"

cleanup_cashbook
summary
