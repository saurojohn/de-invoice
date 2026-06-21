#!/bin/bash
# Test 29: Tier 5.7c — Voucher attachments in DATEV bundle
#
# Verifies the same upload flow as 28, but for
# Vouchers. A user uploads a receipt on the Voucher
# detail page (e.g. a scanned paper receipt that
# the user typed up as a manual voucher); the file
# lands in Attachment rows with entityType =
# 'voucher'. The DATEV bundle should pick it up
# and zip it under Belegbilder/<voucherNo>__<origName>.pdf.
#
# Coverage:
#   1. Upload via /api/v1/attachments (entityType =
#      'voucher') → 201 + Attachment row
#   2. GET /api/v1/attachments?entityType=voucher
#      lists the row
#   3. The DATEV bundle includes the file under
#      Belegbilder/<voucherNo>__*
#   4. The MANIFEST.belegbilderIncluded counts it
#   5. Delete via /api/v1/attachments/:id removes
#      both the row and the bundled file on the
#      next export
#
# The Voucher itself is a minimal BankReconciliation
# stub (Bank 1200 / Forderung 1406) — no need to
# link it to a real Invoice for the bundle test.
# We only need the date + status='posted' to
# satisfy collectBelegbilder's filter.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5.7c Voucher attachments in DATEV bundle ==="

# ----- Fixed seed IDs -----
VCH_ID="e2e0e0e0-0001-0000-0007-0000000000b1"
VCH_NO="E2E-T7C-VCH-01"
BANK_ACC="e2e0e0e0-0001-0000-0007-0000000000b2"
RECV_ACC="e2e0e0e0-0001-0000-0007-0000000000b3"

# ----- Clean up any prior run (idempotent re-runs)
# We deliberately DO NOT delete Account rows here
# — they're owned by 07 (the per-company DATEV
# test) and deleting them would break that test.
# Our Voucher + its lines + the Attachment get
# removed on each run.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Attachment\" WHERE \"entityType\" = 'voucher' AND \"entityId\" = '$VCH_ID';
  DELETE FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';
  DELETE FROM \"Voucher\" WHERE id = '$VCH_ID';" >/dev/null 2>&1

# Seed: a posted Voucher + 2 lines (Bank 1200 / Ford 1406)
# We upsert the Accounts with ON CONFLICT (the 07
# test creates them too), but the conflict path
# generates a new row id when the row already
# exists — our hard-coded BANK_ACC / RECV_ACC ids
# would not match the real row. So we INSERT with
# a fixed id; if it already exists, do nothing.
# Then we re-fetch the real id by accountNumber.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Account\" (id, \"companyId\", \"accountNumber\", name, type, category, \"createdAt\")
  VALUES ('$BANK_ACC', '$COMPANY_ID', '1200', 'Bank', 'asset', 'liquidity', now())
  ON CONFLICT (\"companyId\", \"accountNumber\") DO NOTHING;
  INSERT INTO \"Account\" (id, \"companyId\", \"accountNumber\", name, type, category, \"createdAt\")
  VALUES ('$RECV_ACC', '$COMPANY_ID', '1406', 'Forderungen', 'asset', 'receivables', now())
  ON CONFLICT (\"companyId\", \"accountNumber\") DO NOTHING;
" >/dev/null 2>&1

# Fetch the real account IDs (might differ from
# the hard-coded ones if a previous run left a
# row with a different id but the same number).
BANK_ACC=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200' LIMIT 1;" 2>/dev/null | tr -d ' ')
RECV_ACC=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1406' LIMIT 1;" 2>/dev/null | tr -d ' ')

docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description,
                          \"referenceType\", status, \"createdAt\")
  VALUES ('$VCH_ID', '$COMPANY_ID', '$VCH_NO', '2026-05-15',
          'E2E voucher with attachment', 'BankReconciliation', 'posted', now())
  ON CONFLICT (id) DO UPDATE SET
    \"voucherNumber\" = EXCLUDED.\"voucherNumber\",
    status = EXCLUDED.status;

  DELETE FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';
  INSERT INTO \"VoucherLine\" (id, \"voucherId\", \"accountId\", description, debit, credit, \"sortOrder\")
  VALUES (gen_random_uuid()::text, '$VCH_ID', '$BANK_ACC', 'Bank Kunde', 100.00, 0, 0),
         (gen_random_uuid()::text, '$VCH_ID', '$RECV_ACC', 'Forderung', 0, 100.00, 1);
" >/dev/null 2>&1

# Sanity check the Voucher exists (the test fails
# fast here if the seed didn't take — better than
# getting a confusing 404 from the upload step).
VCH_EXISTS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Voucher\" WHERE id = '$VCH_ID';" 2>/dev/null | tr -d ' ')
if [[ "$VCH_EXISTS" != "1" ]]; then
  echo "FATAL: Voucher seed did not persist" >&2
  exit 2
fi

# ===== 1) Upload via /api/v1/attachments (entityType=voucher) =====
TMPF="/tmp/e2e-voucher-beleg.pdf"
cat > "$TMPF" <<'PDF'
%PDF-1.4
%fake E2E voucher attachment test PDF
%%EOF
PDF

UPLOAD_RES=$(curl -sS -X POST -w "\n%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -F "file=@$TMPF" \
  -F "companyId=$COMPANY_ID" \
  -F "entityType=voucher" \
  -F "entityId=$VCH_ID" \
  -F "uploadedById=$USER_ID" \
  "http://localhost:3001/api/v1/attachments")
STATUS=$(echo "$UPLOAD_RES" | tail -n1)
BODY=$(echo "$UPLOAD_RES" | sed '$d')
assert_status "201" "POST /attachments (voucher)"
ATT_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
ATT_PATH=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['storagePath'])")
ATT_MIME=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['mimeType'])")
note "uploaded attachment id=$ATT_ID path=$ATT_PATH mime=$ATT_MIME"
rm -f "$TMPF"

# Verify Attachment row exists with entityType=voucher
ROW_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Attachment\" WHERE id = '$ATT_ID' AND \"entityType\" = 'voucher';" 2>/dev/null | tr -d ' ')
assert_eq "Attachment row with entityType=voucher exists" "$ROW_COUNT" "1"

# ===== 2) GET /api/v1/attachments?entityType=voucher =====
LIST_BODY=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/attachments?companyId=$COMPANY_ID&entityType=voucher&entityId=$VCH_ID")
LIST_COUNT=$(echo "$LIST_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(len(d) if isinstance(d, list) else 0)
")
assert_eq "GET /attachments (voucher) list count" "$LIST_COUNT" "1"

# ===== 3) Bundle includes the Voucher attachment =====
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle-vch.zip

# The bundle includes the voucher attachment as
# Belegbilder/<voucherNo>__<origName>.<ext>
BUNDLED_NAME=$(unzip -l /tmp/bundle-vch.zip 2>/dev/null | grep -oE "Belegbilder/${VCH_NO}__[a-zA-Z0-9_.-]+\.pdf" | head -1)
if [[ -n "$BUNDLED_NAME" ]]; then
  pass "bundle has Belegbilder/${VCH_NO}__* entry ($BUNDLED_NAME)"
else
  fail "no Belegbilder/${VCH_NO}__* entry in bundle"
  unzip -l /tmp/bundle-vch.zip 2>/dev/null | grep -E "Belegbilder" | head -3
fi

# Verify the bytes inside the zip
if [[ -n "$BUNDLED_NAME" ]]; then
  unzip -p /tmp/bundle-vch.zip "$BUNDLED_NAME" 2>/dev/null > /tmp/bundle-vch-pdf.pdf
  if head -c 5 /tmp/bundle-vch-pdf.pdf | grep -q "%PDF-"; then
    pass "bundled voucher attachment starts with %PDF- magic"
  else
    fail "bundled voucher attachment is not a real PDF"
  fi
else
  fail "skipped PDF byte check (no bundled entry)"
fi

# ===== 4) MANIFEST.belegbilderIncluded counts it =====
# The bundle includes everything (invoices + receipts +
# this voucher attachment). We just check the count
# is >= 1 (the voucher attachment we just added).
unzip -p /tmp/bundle-vch.zip MANIFEST.json > /tmp/bundle-vch-manifest.json
MFG_INC=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-vch-manifest.json'))
print(d['belegbilderIncluded'])
")
if [[ "$MFG_INC" -ge 1 ]]; then
  pass "MANIFEST.belegbilderIncluded >= 1 (got: $MFG_INC)"
else
  fail "MANIFEST.belegbilderIncluded should be >= 1, got: $MFG_INC"
fi

# Also check index.json has the voucher attachment
unzip -p /tmp/bundle-vch.zip Belegbilder/index.json > /tmp/bundle-vch-idx.json
IDX_HAS_VCH=$(python3 -c "
import json
d = json.load(open('/tmp/bundle-vch-idx.json'))
print(any('$VCH_NO' in e.get('belegfeld1', '') for e in d))
")
assert_eq "index.json has voucher attachment entry" "$IDX_HAS_VCH" "True"

# ===== 5) Delete the attachment, bundle updates =====
DEL_STATUS=$(curl -sS -X DELETE -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/attachments/$ATT_ID?companyId=$COMPANY_ID")
assert_eq "DELETE /attachment (voucher) returns 200" "$DEL_STATUS" "200"

# Verify the Attachment row is gone
ROW_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Attachment\" WHERE id = '$ATT_ID';" 2>/dev/null | tr -d ' ')
assert_eq "deleted Attachment row gone" "$ROW_COUNT" "0"

# Re-fetch the bundle — the Voucher attachment should be missing now
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export-bundle?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/bundle-vch2.zip
COUNT_PRESENT=$(unzip -l /tmp/bundle-vch2.zip 2>/dev/null | grep -F -c "Belegbilder/${VCH_NO}__")
assert_eq "bundle no longer has voucher attachment" "$COUNT_PRESENT" "0"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Attachment\" WHERE \"entityType\" = 'voucher' AND \"entityId\" = '$VCH_ID';
  DELETE FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';
  DELETE FROM \"Voucher\" WHERE id = '$VCH_ID';
  DELETE FROM \"Account\" WHERE id IN ('$BANK_ACC', '$RECV_ACC');" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
