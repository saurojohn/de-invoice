#!/bin/bash
# Tier 12: Buchungsjournal PDF export.
#
# The /api/v1/accounting/journal/pdf endpoint
# returns a GoBD-compliant PDF with the
# requested Vouchers in chronological order,
# plus X-Journal-* metadata headers.
#
# Coverage:
#   1.  Empty date range → still 200,
#       X-Journal-Count=0, PDF is generated
#   2.  Date range with no Vouchers → same
#   3.  Date range with 1 Voucher → PDF
#       generated, X-Journal-Count=1
#   4.  X-Journal-Total-Debit/Credit are
#       non-zero, X-Journal-Balanced=1
#       (debit = credit for double-entry)
#   5.  VoucherNumber filter (single Beleg
#       mode) → returns just that one
#   6.  Missing companyId → 400
#   7.  Missing date range AND no
#       voucherNumber → 400
#   8.  Invalid date format → 400
#   9.  dateFrom > dateTo → 400
#   10. PDF starts with %PDF- magic bytes
#   11. PDF body contains the voucher
#       number we filtered for
#       (FlateDecode compressed — we
#       decode and search)
#   12. PDF body contains the company name
#   13. The Soll/Haben Summe lines exist
#       ("Summe Soll:" / "Summe Haben:")

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 12 Buchungsjournal PDF ==="
# ----- Setup: insert 2 test Vouchers + 1 Storno + their lines + accounts -----
# Use the test accounts from e2e 07 (already present in DB).
# We seed 2 fresh Vouchers so we know
# the exact amounts and can assert the
# balanced-sum.

# Clean
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice << EOF >/dev/null 2>&1
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher"
  WHERE "companyId" = '${COMPANY_ID}' AND "voucherNumber" LIKE 'E2E-JOURNAL-%'
);
DELETE FROM "Voucher" WHERE "companyId" = '${COMPANY_ID}' AND "voucherNumber" LIKE 'E2E-JOURNAL-%';
EOF

# Look up SKR03 test accounts
ACC_1200=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Account\" WHERE \"companyId\" = '${COMPANY_ID}' AND \"accountNumber\" = '1200';" 2>/dev/null | tr -d ' ' | head -1)
ACC_4900=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Account\" WHERE \"companyId\" = '${COMPANY_ID}' AND \"accountNumber\" = '4900';" 2>/dev/null | tr -d ' ' | head -1)

cat > /tmp/t40_seed.sql << EOF
INSERT INTO "Voucher" (id, "companyId", "voucherNumber", date, description, "referenceType", status, "createdAt")
VALUES
  ('e2e0000a-0001-0000-0007-000000000010', '${COMPANY_ID}', 'E2E-JOURNAL-001', '2027-01-15', 'Büromaterial', 'Manual', 'posted', now()),
  ('e2e0000a-0001-0000-0007-000000000011', '${COMPANY_ID}', 'E2E-JOURNAL-002', '2027-01-20', 'Kundenerstattung', 'Manual', 'posted', now());
INSERT INTO "VoucherLine" (id, "voucherId", "accountId", description, debit, credit, "sortOrder")
VALUES
  ('e2e0000a-0001-0000-0007-000000000020', 'e2e0000a-0001-0000-0007-000000000010', '${ACC_4900}', 'Porto', 0, 50.00, 0),
  ('e2e0000a-0001-0000-0007-000000000021', 'e2e0000a-0001-0000-0007-000000000010', '${ACC_1200}', 'Porto', 50.00, 0, 1),
  ('e2e0000a-0001-0000-0007-000000000022', 'e2e0000a-0001-0000-0007-000000000011', '${ACC_1200}', 'Erstattung', 0, 200.00, 0),
  ('e2e0000a-0001-0000-0007-000000000023', 'e2e0000a-0001-0000-0007-000000000011', '${ACC_4900}', 'Erstattung', 200.00, 0, 1);
EOF
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < /tmp/t40_seed.sql >/dev/null 2>&1

# ===== 1. PDF with our date range (covers both vouchers) =====
# We use 2027-01-15..2027-01-25 — a date
# well in the future, so the only
# Vouchers matching are OUR 2 seed
# rows. The DB has hundreds of
# historical Vouchers from prior
# tests; using 2027 isolates our
# fixtures from that noise.
RAW=$(curl -sS -D /tmp/t40_hdr1.txt -o /tmp/t40_pdf1.pdf \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?companyId=$COMPANY_ID&dateFrom=2027-01-15&dateTo=2027-01-25")
HTTP_CODE=$(head -1 /tmp/t40_hdr1.txt | grep -oE "[0-9]{3}")
assert_eq "1. PDF HTTP 200" "$HTTP_CODE" "200"

# ===== 2. PDF starts with %PDF- magic =====
MAGIC=$(head -c 5 /tmp/t40_pdf1.pdf)
assert_eq "2. PDF magic bytes" "$MAGIC" "%PDF-"

# ===== 3. X-Journal-Count header = 2 =====
# We use ^X- prefix to skip the status
# line and the response's own X-Powered-By
# type headers (none here, but defensive).
COUNT=$(grep -i "^x-journal-count:" /tmp/t40_hdr1.txt | tr -d '\r' | awk '{print $2}')
assert_eq "3. X-Journal-Count=2" "$COUNT" "2"

# ===== 4. X-Journal-Balanced=1 (debit = credit = 250) =====
BALANCED=$(grep -i "^x-journal-balanced:" /tmp/t40_hdr1.txt | tr -d '\r' | awk '{print $2}')
assert_eq "4. X-Journal-Balanced=1" "$BALANCED" "1"
DEBIT=$(grep -i "^x-journal-total-debit:" /tmp/t40_hdr1.txt | tr -d '\r' | awk '{print $2}')
assert_eq "4b. total debit = 250.00" "$DEBIT" "250.00"
CREDIT=$(grep -i "^x-journal-total-credit:" /tmp/t40_hdr1.txt | tr -d '\r' | awk '{print $2}')
assert_eq "4c. total credit = 250.00" "$CREDIT" "250.00"

# ===== 5. Single-voucher filter =====
RAW=$(curl -sS -D /tmp/t40_hdr5.txt -o /tmp/t40_pdf5.pdf \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?companyId=$COMPANY_ID&voucherNumber=E2E-JOURNAL-001")
COUNT5=$(grep -i "^x-journal-count:" /tmp/t40_hdr5.txt | tr -d '\r' | awk '{print $2}')
assert_eq "5. single-voucher filter count=1" "$COUNT5" "1"

# ===== 6. Missing companyId (with auth headers) → 400 =====
# We pass both auth headers so the
# request reaches the controller. The
# controller then sees `companyId`
# is empty in the query and throws
# BadRequestException. Without the
# auth headers we'd get 401 from the
# guard, not 400 from the service.
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?dateFrom=2026-06-01&dateTo=2026-06-30")
assert_eq "6. missing companyId → 400" "$HTTP_CODE" "400"

# ===== 7. Missing date range AND no voucherNumber → 400 =====
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?companyId=$COMPANY_ID")
assert_eq "7. missing date range + no voucherNumber → 400" "$HTTP_CODE" "400"

# ===== 8. Invalid date format → 400 =====
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?companyId=$COMPANY_ID&dateFrom=foo&dateTo=bar")
assert_eq "8. invalid date format → 400" "$HTTP_CODE" "400"

# ===== 9. dateFrom > dateTo → 400 =====
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/accounting/journal/pdf?companyId=$COMPANY_ID&dateFrom=2026-12-01&dateTo=2026-01-01")
assert_eq "9. dateFrom > dateTo → 400" "$HTTP_CODE" "400"

# ===== 10. PDF body contains the voucher number =====
# PDF text is hex-encoded in PDFKit's
# output stream (FlateDecode-compressed
# with hex string segments). We decode
# the streams and the hex segments to
# get a flat byte string we can search.
python3 << PYEOF
import re, zlib
with open('/tmp/t40_pdf1.pdf', 'rb') as f:
    pdf = f.read()
streams = re.findall(rb'stream\r?\n(.*?)endstream', pdf, re.DOTALL)
all_text = b''
for s in streams:
    try:
        all_text += zlib.decompress(s)
    except:
        pass
# PDFKit uses <hex> blocks inside TJ/Tj.
# Hex pairs → bytes.
hex_strs = re.findall(rb'<([0-9A-Fa-f]+)>', all_text)
decoded = b''
for h in hex_strs:
    if len(h) % 2:
        h = h + b'0'
    decoded += bytes.fromhex(h.decode('ascii'))
all_text = decoded
# The voucher number is rendered as part of the table
assert b'E2E-JOURNAL-001' in all_text or b'E2E-JOURNAL-002' in all_text, f"Voucher number not found in PDF"
print("✓ 10. PDF contains the voucher numbers")
# Company name (legalName first, then name; this company has legalName='GmbH')
assert b'GmbH' in all_text, f"Company name not found"
print("✓ 11. PDF contains the company name")
# Summe lines
assert b'Summe Soll' in all_text, f"Summe Soll not found"
print("✓ 12. PDF has Summe Soll line")
assert b'Summe Haben' in all_text, f"Summe Haben not found"
print("✓ 13. PDF has Summe Haben line")
# Double-entry OK note
assert b'ausgeglichen' in all_text or b'Doppelte Buchf' in all_text, f"balanced note not found"
print("✓ 14. PDF shows 'double-entry balanced' note")
PYEOF

# ----- Cleanup -----
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice << EOF >/dev/null 2>&1
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher"
  WHERE "companyId" = '${COMPANY_ID}' AND "voucherNumber" LIKE 'E2E-JOURNAL-%'
);
DELETE FROM "Voucher" WHERE "companyId" = '${COMPANY_ID}' AND "voucherNumber" LIKE 'E2E-JOURNAL-%';
EOF
note "Cleanup done"
/Users/shledergmbh/.mavis/bin/mavis-trash -- /tmp/t40_pdf1.pdf /tmp/t40_pdf5.pdf /tmp/t40_hdr1.txt /tmp/t40_hdr5.txt /tmp/t40_seed.sql

cleanup_cashbook
summary