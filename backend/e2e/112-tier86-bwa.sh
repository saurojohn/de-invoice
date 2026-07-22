#!/usr/bin/env bash
# e2e 112: Tier 86 — BWA (Betriebswirtschaftliche
# Auswertung).
#
# Validates the new /api/v1/reports/bwa + /bwa.pdf
# endpoints. The BWA is the monthly operating
# report a Steuerberater sends to the Mandant.
# Canonical DATEV BWA structure with 4-digit bucket
# codes (1000-5999) and Monat/Vormonat/YTD/
# Vorjahres-YTD/Δ% columns.
#
# Tests:
#   1. /bwa reachable + shape (7 standard lines).
#   2. Each line has the 5 numeric columns
#      (monat, vormonat, ytd, vorjahresYtd,
#      ytdChangePct) + bucket + label.
#   3. DATEV bucket codes 1000/1300/2000/3000/
#      3100/3600/4200 are present.
#   4. Computed Umsatzerlöse matches Invoice
#      sum in the year.
#   5. Computed Materialaufwand matches
#      Material-category Expense sum in the year.
#   6. Computed Personalkosten matches Personal-
#      category Expense sum in the year.
#   7. Computed Sonstige betriebliche
#      Aufwendungen matches other Expenses.
#   8. Betriebsergebnis identity: Erlöse -
#      Material - Personal - AfA - sonstige.
#   9. PDF endpoint returns application/pdf
#      with %PDF magic bytes.
#  10. Year validation 1999, 2101 → 400.
#  11. Month validation 0, 13 → 400.
#  12. Cross-tenant → 401.
#  13. Missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="bwa-tier86-$TS"
echo "=== Test: BWA (test tag: $TEST_TAG) ==="

# Pre-cleanup: remove any orphan BWA-* fixtures
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"InvoiceItem\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'BWA-%');" >/dev/null 2>&1
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'BWA-%';" >/dev/null 2>&1
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"invoiceNumber\" LIKE 'BWA-%';" >/dev/null 2>&1

cleanup() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"InvoiceItem\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'BWA-${TS}-%');" >/dev/null 2>&1
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'BWA-${TS}-%';" >/dev/null 2>&1
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "DELETE FROM \"Expense\" WHERE \"invoiceNumber\" LIKE 'BWA-${TS}-%';" >/dev/null 2>&1
  echo "  cleanup: removed BWA-${TS}-* rows"
}
trap cleanup EXIT

# Seed a Customer
TMP_SQL=$(mktemp -t bwa-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId", "address", "paymentTerms", "tags", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'BWA Test Kunde', 'BWA-${TS}-DE-1', NULL, '{"country":"Deutschland"}'::jsonb, 30, ARRAY[]::text[], now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\"='$COMPANY_ID' AND \"customerNumber\"='BWA-${TS}-DE-1';" \
  2>&1 | tr -d ' ' | head -1)

# Capture baseline
BASE=$(curl -sS \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")

BASE_UMSATZ_YTD=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
  if l['bucket'] == '1000':
    print(l['ytd'])
    break
")
BASE_MAT_YTD=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
  if l['bucket'] == '2000':
    print(l['ytd'])
    break
")
BASE_PERS_YTD=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
  if l['bucket'] == '3000':
    print(l['ytd'])
    break
")
BASE_SONST_YTD=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
  if l['bucket'] == '3600':
    print(l['ytd'])
    break
")
echo "  Baseline YTD: umsatz=$BASE_UMSATZ_YTD material=$BASE_MAT_YTD personal=$BASE_PERS_YTD sonstige=$BASE_SONST_YTD"

# Seed an invoice: 1000 net @ 19% USt → 1000 to Umsatzerlöse YTD (date in May, BWA month=June)
INV1_ID="inv-bwa-1-$TS"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV1_ID'::text, '$COMPANY_ID', '$CUST_ID', 'BWA-${TS}-INV-1', 'INV', 'paid',
        '2026-04-15'::date, 1000, 190, 1190, 'EUR', 'de-DE', false, false, 'BWA Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV1_ID', 'Beratung', 1, 1000, 0.19, 1000, 190, 1190, 0, now());
EOF

# Seed an invoice in May: 500 net → goes to YTD only
INV2_ID="inv-bwa-2-$TS"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV2_ID'::text, '$COMPANY_ID', '$CUST_ID', 'BWA-${TS}-INV-2', 'INV', 'paid',
        '2026-05-10'::date, 500, 95, 595, 'EUR', 'de-DE', false, false, 'BWA Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV2_ID', 'Wartung', 1, 500, 0.19, 500, 95, 595, 0, now());
EOF

# Seed expenses: Material 300 (5a), Personal 400 (6a), Schuldzins 100 (13)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Expense" (id, "companyId", "invoiceNumber", description, "invoiceDate",
                       "netAmount", "vatRate", "vatAmount", "grossAmount", category, status,
                       "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'BWA-${TS}-EXP-1', 'Material',     '2026-04-10'::date, 252.10, 0.19, 47.90, 300, 'Material',     'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'BWA-${TS}-EXP-2', 'Lohn',         '2026-04-20'::date, 336.13, 0.19, 63.87, 400, 'Personal',     'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'BWA-${TS}-EXP-3', 'Schuldzins',   '2026-04-25'::date,  84.03, 0.19, 15.97, 100, 'Schuldzins',   'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'BWA-${TS}-EXP-4', 'Miete',        '2026-05-01'::date, 168.07, 0.19, 31.93, 200, 'Miete',        'booked', now(), now());
EOF

# ── 1. JSON shape + 7 lines ──
echo
note "=== 1. /bwa reachable + 7 standard lines ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "bwa 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year','month','vorjahr','company','lines','totals','counts','generatedAt','disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# 7 standard lines (1000, 1300, 2000, 3000, 3100, 3600, 4200)
NLINES=$(python3 -c "
import json
d = json.load(open('$TMP'))
print(len(d['lines']))
")
assert_eq "7 standard BWA lines" "$NLINES" "7"

# ── 2. Each line has 5 numeric columns + bucket + label ──
echo
note "=== 2. each line has bucket + label + 5 numeric columns ==="
ALL_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
ok = all(
  set(l.keys()) >= {'bucket','label','monat','vormonat','ytd','vorjahresYtd','ytdChangePct'}
  for l in d['lines']
)
print('true' if ok else 'false')
")
assert_eq "all lines have required columns" "$ALL_OK" "true"

# ── 3. DATEV bucket codes present ──
echo
note "=== 3. DATEV bucket codes 1000/1300/2000/3000/3100/3600/4200 present ==="
BUCKETS_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
expected = ['1000','1300','2000','3000','3100','3600','4200']
actual = [l['bucket'] for l in d['lines']]
print('true' if actual == expected else f'got {actual}')
")
assert_eq "DATEV bucket codes" "$BUCKETS_OK" "true"

# ── 4. YTD Umsatzerlöse delta = +1500 (1000 + 500) ──
echo
note "=== 4. YTD Umsatzerlöse (1000) delta = +1500 (1000 + 500) ==="
NEW_UMSATZ_YTD=$(python3 -c "
import json
d = json.load(open('$TMP'))
for l in d['lines']:
  if l['bucket'] == '1000':
    print(l['ytd'])
    break
")
D_UMSATZ=$(python3 -c "print(int(float('$NEW_UMSATZ_YTD') - float('$BASE_UMSATZ_YTD')))")
assert_eq "Umsatzerlöse YTD delta = +1500" "$D_UMSATZ" "1500"

# ── 5. YTD Material delta = +300 ──
echo
note "=== 5. YTD Materialaufwand (2000) delta = +300 ==="
NEW_MAT_YTD=$(python3 -c "
import json
d = json.load(open('$TMP'))
for l in d['lines']:
  if l['bucket'] == '2000':
    print(l['ytd'])
    break
")
D_MAT=$(python3 -c "print(int(float('$NEW_MAT_YTD') - float('$BASE_MAT_YTD')))")
assert_eq "Materialaufwand YTD delta = +300" "$D_MAT" "300"

# ── 6. YTD Personal delta = +400 ──
echo
note "=== 6. YTD Personalkosten (3000) delta = +400 ==="
NEW_PERS_YTD=$(python3 -c "
import json
d = json.load(open('$TMP'))
for l in d['lines']:
  if l['bucket'] == '3000':
    print(l['ytd'])
    break
")
D_PERS=$(python3 -c "print(int(float('$NEW_PERS_YTD') - float('$BASE_PERS_YTD')))")
assert_eq "Personalkosten YTD delta = +400" "$D_PERS" "400"

# ── 7. YTD Sonstige Aufwendungen delta = +200 ──
echo
note "=== 7. YTD Sonstige betr. Aufw. (3600) delta = +200 (Miete) ==="
NEW_SONST_YTD=$(python3 -c "
import json
d = json.load(open('$TMP'))
for l in d['lines']:
  if l['bucket'] == '3600':
    print(l['ytd'])
    break
")
D_SONST=$(python3 -c "print(int(float('$NEW_SONST_YTD') - float('$BASE_SONST_YTD')))")
assert_eq "Sonstige Aufwendungen YTD delta = +200" "$D_SONST" "200"

# ── 8. Betriebsergebnis identity: YTD = umsatz - mat - pers - afa - sonstige ──
echo
note "=== 8. Betriebsergebnis YTD identity ==="
BE_IDENTITY=$(python3 -c "
import json
d = json.load(open('$TMP'))
umsatz = next(l['ytd'] for l in d['lines'] if l['bucket'] == '1000')
mat = next(l['ytd'] for l in d['lines'] if l['bucket'] == '2000')
pers = next(l['ytd'] for l in d['lines'] if l['bucket'] == '3000')
afa = next(l['ytd'] for l in d['lines'] if l['bucket'] == '3100')
sonstige = next(l['ytd'] for l in d['lines'] if l['bucket'] == '3600')
expected = umsatz - mat - pers - afa - sonstige
actual = d['totals']['betriebsergebnisYtd']
print('true' if abs(expected - actual) < 0.01 else f'expected={expected} actual={actual}')
")
assert_eq "Betriebsergebnis YTD identity" "$BE_IDENTITY" "true"

# ── 9. PDF endpoint ──
echo
note "=== 9. /bwa.pdf returns application/pdf + magic bytes ==="
PDF_RESP=$(curl -sS -o /tmp/bwa-tier86.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/reports/bwa.pdf?companyId=$COMPANY_ID&year=2026&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$PDF_RESP" | cut -d'|' -f1)
CT=$(echo "$PDF_RESP" | cut -d'|' -f2)
assert_eq "PDF 200" "$HTTP" "200"
assert_eq "PDF content-type" "$CT" "application/pdf"
MAGIC=$(head -c 4 /tmp/bwa-tier86.pdf | od -An -tx1 | tr -d ' \n')
assert_eq "PDF magic bytes (25 50 44 46)" "$MAGIC" "25504446"
rm -f /tmp/bwa-tier86.pdf

# ── 10. year validation ──
echo
note "=== 10. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=1999&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2101&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 11. month validation ──
echo
note "=== 11. month validation ==="
ST_M0=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=0" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "month=0 → 400" "$ST_M0" "400"
ST_M13=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=13" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "month=13 → 400" "$ST_M13" "400"

# ── 12. Cross-tenant → 401 ──
echo
note "=== 12. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=6" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 13. Missing companyId → 400 ──
echo
note "=== 13. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?year=2026&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$TMP"
summary
exit $?
