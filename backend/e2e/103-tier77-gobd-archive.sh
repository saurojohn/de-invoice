#!/usr/bin/env bash
# e2e 103: Tier 77 — GoBD Document Archive (§ 147 AO).
#
# Validates the new /api/v1/accounting/gobd-archive
# + /gobd-archive/summary endpoints that stream a
# year-end GoBD-compliant ZIP archive (invoices
# + expenses + audit log + manifest).
#
# Tests:
#   1. Summary endpoint reachable, returns the
#      expected shape (counts + totals).
#   2. Invoice/expense counts match the DB for
#      the year.
#   3. Revenue + expense + VAT + Vorsteuer
#      totals are non-zero for a year with data.
#   4. ZIP endpoint returns application/zip
#      with a non-empty body.
#   5. ZIP contains MANIFEST.json, Buchungsstapel.csv,
#      Audit-Log.csv, plus Invoices/ and Expenses/
#      sub-folders.
#   6. MANIFEST.json contains a 64-char SHA-256
#      hash (the integrity anchor).
#   7. Audit-Log.csv has the UTF-8 BOM (German
#      Excel needs it for correct auto-detection).
#   8. year validation: 1999, 2101 → 400.
#   9. Default year (= previous calendar year) works.
#  10. Missing companyId → 400.
#  11. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

# ── 1. Summary endpoint shape ──
echo
note "=== 1. GET /accounting/gobd-archive/summary shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/accounting/gobd-archive/summary?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "summary 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['companyId', 'year', 'invoiceCount', 'expenseCount', 'attachmentCount', 'auditLogCount', 'totalRevenueNet', 'totalExpenseNet', 'totalVat', 'totalVorsteuer', 'generatedAt']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all summary keys present" "$HAS_KEYS" "true"

# ── 2. Invoice/expense counts match the DB ──
echo
note "=== 2. invoice/expense counts match the DB ==="
# Get DB counts directly
DB_INV=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Invoice\" WHERE \"companyId\"='$COMPANY_ID' AND \"issueDate\">='2026-01-01' AND \"issueDate\"<='2026-12-31';" \
  2>&1 | tr -d ' ' | head -1)
DB_EXP=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"companyId\"='$COMPANY_ID' AND \"invoiceDate\">='2026-01-01' AND \"invoiceDate\"<='2026-12-31';" \
  2>&1 | tr -d ' ' | head -1)
API_INV=$(python3 -c "import json; print(json.load(open('$TMP'))['invoiceCount'])")
API_EXP=$(python3 -c "import json; print(json.load(open('$TMP'))['expenseCount'])")
assert_eq "invoice count matches DB" "$API_INV" "$DB_INV"
assert_eq "expense count matches DB" "$API_EXP" "$DB_EXP"

# ── 3. Totals are non-zero ──
echo
note "=== 3. totals are non-zero ==="
TOTALS_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
ok = (
  d['totalRevenueNet'] > 0 and
  d['totalVat'] > 0 and
  d['totalVorsteuer'] > 0
)
print('true' if ok else f'zero totals: rev={d[\"totalRevenueNet\"]} vat={d[\"totalVat\"]} vst={d[\"totalVorsteuer\"]}')
")
assert_eq "totals non-zero" "$TOTALS_OK" "true"

# ── 4. ZIP endpoint ──
echo
note "=== 4. GET /accounting/gobd-archive returns ZIP ==="
ZIP_RESP=$(curl -sS -o /tmp/gobd-test.zip -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/accounting/gobd-archive?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$ZIP_RESP" | cut -d'|' -f1)
CT=$(echo "$ZIP_RESP" | cut -d'|' -f2)
SIZE=$(echo "$ZIP_RESP" | cut -d'|' -f3)
assert_eq "ZIP 200" "$HTTP" "200"
assert_eq "ZIP content-type" "$CT" "application/zip"
# PK magic bytes: PK\x03\x04
MAGIC=$(head -c 4 /tmp/gobd-test.zip | od -An -tx1 | tr -d ' \n')
assert_eq "ZIP magic bytes" "$MAGIC" "504b0304"

# ── 5. ZIP structure ──
echo
note "=== 5. ZIP structure has MANIFEST + DATEV + Audit + Invoices + Expenses ==="
ZIP_OK=$(unzip -l /tmp/gobd-test.zip 2>/dev/null | python3 -c "
import sys
lines = sys.stdin.read()
ok = (
  'MANIFEST.json' in lines and
  'Buchungsstapel.csv' in lines and
  'Audit-Log.csv' in lines and
  'Invoices/' in lines and
  'Expenses/' in lines
)
print('true' if ok else 'missing files')
")
assert_eq "all 5 expected entries present" "$ZIP_OK" "true"

# ── 6. MANIFEST has SHA-256 ──
echo
note "=== 6. MANIFEST.json contains a 64-char SHA-256 hash ==="
HASH_OK=$(unzip -p /tmp/gobd-test.zip MANIFEST.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d.get('manifestSha256', '')
import re
ok = bool(re.match(r'^[0-9a-f]{64}$', h))
print('true' if ok else f'bad hash: {h[:20]}...')
")
assert_eq "manifest SHA-256 is 64 hex chars" "$HASH_OK" "true"

# ── 7. Audit-Log UTF-8 BOM ──
echo
note "=== 7. Audit-Log.csv starts with UTF-8 BOM ==="
BOM_OK=$(head -c 3 /tmp/gobd-test.zip 2>/dev/null && unzip -p /tmp/gobd-test.zip Audit-Log.csv | head -c 3 | od -c | head -1)
# The BOM is the first 3 bytes of Audit-Log.csv
# inside the zip
ACTUAL_BOM=$(unzip -p /tmp/gobd-test.zip Audit-Log.csv 2>/dev/null | head -c 3 | od -An -tx1 | tr -d ' \n')
EXPECTED_BOM="efbbbf"
assert_eq "Audit-Log BOM matches" "$ACTUAL_BOM" "$EXPECTED_BOM"

# ── 8. year validation ──
echo
note "=== 8. year param validation ==="
STATUS_OLD=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/gobd-archive/summary?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_OLD" "400"

STATUS_FUTURE=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/gobd-archive/summary?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$STATUS_FUTURE" "400"

# ── 9. Default year works ──
echo
note "=== 9. default year (= previous calendar year) ==="
DEFAULT_YEAR=$(curl -sS \
  "$API/api/v1/accounting/gobd-archive/summary?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['year'])")
# 2026 in our env → default = 2025
assert_eq "default year is 2025" "$DEFAULT_YEAR" "2025"

# ── 10. Missing companyId → 400 ──
echo
note "=== 10. missing companyId → 400 ==="
STATUS_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/gobd-archive/summary" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "no companyId → 400" "$STATUS_NO_CID" "400"

# ── 11. Cross-tenant → 401 ──
echo
note "=== 11. cross-tenant → 401 ==="
STATUS_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/gobd-archive/summary?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$STATUS_CROSS" "401"

rm -f "$TMP" /tmp/gobd-test.zip
summary
exit $?
