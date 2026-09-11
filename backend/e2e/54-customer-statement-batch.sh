#!/bin/bash
# e2e/54-customer-statement-batch.sh — Tier 20.2
#
# Verifies GET /api/v1/customers/statements-batch returns
# a valid ZIP containing one PDF per customer + index.csv +
# summary.txt.
#
# Strategy: use the existing SH Leder test company which
# already has 167+ customers from earlier tests. We don't
# need to seed any new data; the test just walks the ZIP
# and verifies structure.
#
# Cleanup: none — this test is read-only against the DB
# (creates no customers, no invoices). The generated ZIPs
# land in /tmp and are rm'd at the end.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

FAILS=0
TMP_ZIP=$(mktemp).zip
TMP_DIR=$(mktemp -d)

cleanup() {
  rm -f "$TMP_ZIP"
  mavis-trash "$TMP_DIR" >/dev/null 2>&1 || rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Polish #10: the test used to expect "already has 167+ customers
# from earlier tests" — but the 65 cleanup wipes all customers
# at the start of its run, so by the time 54 runs in a batch
# there might be 0. Bulk-insert 120 test customers if the
# current count is too low. Idempotent: re-running is safe.
EXISTING=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND \"name\" LIKE 'Tier20-%'")
NEED=$((120 - EXISTING))
if [[ $NEED -gt 0 ]]; then
  note "Seeding $NEED Tier20-* test customers for the batch statement test"
  docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Customer" (id, "companyId", name, type, address, "contact", "paymentTerms", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       '$COMPANY_ID',
       'Tier20-' || lpad(g::text, 4, '0'),
       'business',
       '{"street":"Teststr","postalCode":"50667","city":"Köln","country":"DE"}'::jsonb,
       '{}'::jsonb,
       30,
       now(),
       now()
FROM generate_series(1, $NEED) AS g
ON CONFLICT DO NOTHING;
SQL
fi
# Re-count to verify
EXISTING=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND \"name\" LIKE 'Tier20-%'")
pass "Tier20-* customers available: $EXISTING"

# ── Test 1: happy path returns 200 + application/zip ──
note "Fetching batch ZIP for June 2026..."
HTTP=$(curl -s -o "$TMP_ZIP" -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID&from=2026-06-01&to=2026-06-30")
HTTP_CODE="${HTTP%%|*}"
HTTP_TYPE="${HTTP##*|}"
assert_eq "batch endpoint returns 200" "$HTTP_CODE" "200"
assert_eq "Content-Type is application/zip" "$HTTP_TYPE" "application/zip"

# ── Test 2: ZIP magic (PK\x03\x04) ──
MAGIC=$(head -c 4 "$TMP_ZIP" | od -An -tx1 | tr -d ' \n')
assert_eq "ZIP starts with PK magic" "$MAGIC" "504b0304"

# ── Test 3: ZIP is non-empty + reasonable size ──
SIZE=$(wc -c < "$TMP_ZIP" | tr -d ' ')
if [[ $SIZE -lt 10240 ]]; then
  fail "ZIP too small: $SIZE bytes (should be > 10KB for 100+ customers)"
elif [[ $SIZE -gt 10485760 ]]; then
  fail "ZIP too large: $SIZE bytes (> 10MB suggests runaway)"
else
  pass "ZIP size reasonable: $SIZE bytes"
fi

# ── Test 4: ZIP contains summary.txt + index.csv ──
# unzip is provided by macOS by default. Use it (or Python's zipfile)
# for cross-platform safety.
python3 -c "
import zipfile, sys
with zipfile.ZipFile('$TMP_ZIP') as z:
    names = z.namelist()
    has_summary = 'summary.txt' in names
    has_index = 'index.csv' in names
    pdf_count = sum(1 for n in names if n.endswith('.pdf'))
    print(f'OK' if has_summary and has_index and pdf_count > 50 else f'FAIL summary={has_summary} index={has_index} pdfs={pdf_count}')
"
assert_eq "ZIP has summary.txt + index.csv + many PDFs" "$(python3 -c "
import zipfile
with zipfile.ZipFile('$TMP_ZIP') as z:
    names = z.namelist()
    print('OK' if 'summary.txt' in names and 'index.csv' in names and sum(1 for n in names if n.endswith('.pdf')) > 50 else 'FAIL')
")" "OK"

# ── Test 5: summary.txt has expected metadata ──
SUMMARY=$(python3 -c "
import zipfile
with zipfile.ZipFile('$TMP_ZIP') as z:
    print(z.read('summary.txt').decode('utf-8'))
")
echo "$SUMMARY" | grep -q "de-invoice Batch Kontoauszug" \
  && pass "summary.txt contains brand" || fail "summary.txt missing brand"
echo "$SUMMARY" | grep -q "Customer count" \
  && pass "summary.txt contains customer count" || fail "summary.txt missing count"
echo "$SUMMARY" | grep -q "Period:" \
  && pass "summary.txt contains period" || fail "summary.txt missing period"
echo "$SUMMARY" | grep -q "Total open balance" \
  && pass "summary.txt contains open balance" || fail "summary.txt missing open balance"

# ── Test 6: index.csv has header + rows ──
INDEX_HEAD=$(python3 -c "
import zipfile
with zipfile.ZipFile('$TMP_ZIP') as z:
    for line in z.read('index.csv').decode('utf-8').split('\n'):
        if line.startswith('customerNumber'):
            print(line)
            break
")
echo "$INDEX_HEAD" | grep -q "customerNumber;name;openingBalance;closingBalance" \
  && pass "index.csv has expected header columns" \
  || fail "index.csv header: $INDEX_HEAD"

INDEX_ROW_COUNT=$(python3 -c "
import zipfile
with zipfile.ZipFile('$TMP_ZIP') as z:
    print(len([l for l in z.read('index.csv').decode('utf-8').split('\n') if l.strip()]) - 1)
")
if [[ $INDEX_ROW_COUNT -gt 50 ]]; then
  pass "index.csv has $INDEX_ROW_COUNT data rows"
else
  fail "index.csv only has $INDEX_ROW_COUNT data rows"
fi

# ── Test 7: at least one PDF inside the ZIP is a valid PDF ──
FIRST_PDF_OK=$(python3 -c "
import zipfile
with zipfile.ZipFile('$TMP_ZIP') as z:
    for name in z.namelist():
        if name.endswith('.pdf'):
            data = z.read(name)
            # PDF magic: '%PDF-'
            print('OK' if data[:5] == b'%PDF-' else 'FAIL')
            break
    else:
        print('FAIL no pdf found')
")
assert_eq "first PDF in ZIP has valid PDF magic" "$FIRST_PDF_OK" "OK"

# ── Test 8: first PDF contains German labels ──
PDF_TEXT_OK=$(python3 -c "
import zipfile
try:
    from pypdf import PdfReader
    with zipfile.ZipFile('$TMP_ZIP') as z:
        for name in z.namelist():
            if name.endswith('.pdf'):
                r = PdfReader(z.open(name))
                text = ''
                for page in r.pages:
                    text += page.extract_text() + ' '
                if 'Kontoauszug' in text and ('Anfangsbestand' in text or 'Keine Bewegungen' in text):
                    print('OK')
                else:
                    print('FAIL content')
                break
        else:
            print('FAIL no pdf')
except Exception as e:
    print(f'ERROR: {e}')
")
assert_eq "first PDF contains Kontoauszug + (Anfangsbestand or empty-state)" "$PDF_TEXT_OK" "OK"

# ── Test 9: error cases ──
HTTP_400=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID")
assert_eq "missing from/to returns 400" "$HTTP_400" "400"

HTTP_400B=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID&from=2026-06-30&to=2026-06-01")
assert_eq "from > to returns 400" "$HTTP_400B" "400"

HTTP_400C=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID&from=2020-01-01&to=2026-06-01")
assert_eq "range > 24 months returns 400" "$HTTP_400C" "400"

HTTP_400D=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID&from=2026-06-01&to=2026-06-30&order=sideways")
assert_eq "invalid order returns 400" "$HTTP_400D" "400"

# ── Test 10: order=asc is accepted and produces a ZIP too ──
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/statements-batch?companyId=$COMPANY_ID&from=2026-06-01&to=2026-06-30&order=asc")
assert_eq "order=asc returns 200" "$HTTP" "200"

echo ""
echo "==============================="
if [[ $FAILS -eq 0 ]]; then
  echo "54-customer-statement-batch: ALL PASSED ✓"
  exit 0
else
  echo "54-customer-statement-batch: $FAILS FAILURE(S)"
  exit 1
fi