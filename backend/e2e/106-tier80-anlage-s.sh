#!/usr/bin/env bash
# e2e 106: Tier 80 — Anlage S (Einkünfte aus
# selbständiger Arbeit, § 18 EStG).
#
# Validates the new /api/v1/accounting/anlage-s
# + /anlage-s.pdf endpoints. The Anlage S is
# the freelancer / self-employed counterpart
# to the EÜR (§ 15 EStG Gewerbebetrieb). Same
# Kennziffer vocabulary on the revenue side,
# shifted expense side (Kfz, Fortbildung,
# Steuerberatung, etc. — typical freelance
# deductible categories).
#
# Tests:
#   1. JSON shape + all 5 revenue lines + all
#      13 expense lines + totals.
#   2. Eligibility: positive USt → Kz 4100
#      (umsatzsteuerpflichtig).
#   3. Gutschrift (subtotal < 0) offsets
#      Kz 4100 directly (BMF convention).
#   4. Material category → Kz 4620.
#   5. Kfz category → Kz 4660.
#   6. Steuerberatung → Kz 4700.
#   7. Unmatched expense category → Kz 4720
#      (fallback).
#   8. Per-line sum = subtotal = grand total.
#   9. PDF returns application/pdf.
#  10. year validation: 1999, 2101 → 400.
#  11. Cross-tenant → 401.
#  12. missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="anlages-tier80-$TS"
echo "=== Test: Anlage S (test tag: $TEST_TAG) ==="

# Pre-cleanup: remove any orphan ANS-* fixtures
# from previous test runs (the per-run cleanup
# only catches the current $TS; older runs
# accumulate over time and break the
# delta-snapshot assertion).
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'ANS-%');
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'ANS-%';
DELETE FROM "Expense" WHERE "invoiceNumber" LIKE 'ANS-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'ANS-%';
SQL

# Cleanup hook
cleanup() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'ANS-${TS}-%');
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'ANS-${TS}-%';
DELETE FROM "Expense" WHERE "invoiceNumber" LIKE 'ANS-${TS}-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'ANS-${TS}-%';
SQL
}
trap cleanup EXIT

# Seed test customers
TMP_SQL=$(mktemp -t anlages-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId", "address", "paymentTerms", "tags", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'ANS Test Kunde', 'ANS-${TS}-DE-1', NULL, '{"country":"Deutschland"}'::jsonb, 30, ARRAY[]::text[], now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\"='$COMPANY_ID' AND \"customerNumber\"='ANS-${TS}-DE-1';" \
  2>&1 | tr -d ' ' | head -1)

# Capture the baseline BEFORE adding fixtures.
# The dev DB has other invoices/expenses for
# 2026 (from prior tiers + seed) — we assert
# DELTAS against this baseline so the test
# stays deterministic regardless of seed
# data.
BASE=$(curl -sS \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BASE_K4100=$(echo "$BASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'))")
BASE_TOTAL=$(echo "$BASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['ausgabenTotal'])")
BASE_4620=$(echo "$BASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l['amount'] for l in d['ausgaben'] if l['kennziffer']=='4620'))")
BASE_4660=$(echo "$BASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l['amount'] for l in d['ausgaben'] if l['kennziffer']=='4660'))")
BASE_4700=$(echo "$BASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l['amount'] for l in d['ausgaben'] if l['kennziffer']=='4700'))")
BASE_4720=$(echo "$BASE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l['amount'] for l in d['ausgaben'] if l['kennziffer']=='4720'))")
echo "  Baseline: K4100=$BASE_K4100 ausgaben=$BASE_TOTAL (4620=$BASE_4620 4660=$BASE_4660 4700=$BASE_4700 4720=$BASE_4720)"

# Add an invoice: 1000 net @ 19% USt → Kz 4100
INV1_ID="inv-ans-1-$TS"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV1_ID'::text, '$COMPANY_ID', '$CUST_ID', 'ANS-${TS}-INV-1', 'INV', 'paid',
        '2026-05-15'::date, 1000, 190, 1190, 'EUR', 'de-DE',
        false, false, 'ANS Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV1_ID', 'Consulting', 1, 1000, 0.19, 1000, 190, 1190, 0, now());
EOF

# Gutschrift: -200 net (offsets Kz 4100)
INV2_ID="inv-ans-2-$TS"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV2_ID'::text, '$COMPANY_ID', '$CUST_ID', 'ANS-${TS}-INV-2', 'INV', 'paid',
        '2026-06-10'::date, -200, -38, -238, 'EUR', 'de-DE',
        false, false, 'ANS Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV2_ID', 'Storno', 1, -200, 0.19, -200, -38, -238, 0, now());
EOF

# Expenses (4 categories, 1 fallback):
#  Material (4620)        300
#  Kfz (4660)            150
#  Steuerberatung (4700) 200
#  Sonstiges → 4720      100
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Expense" (id, "companyId", "invoiceNumber", description, "invoiceDate",
                       "netAmount", "vatRate", "vatAmount", "grossAmount", category, status,
                       "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'ANS-${TS}-EXP-1', 'Material',  '2026-04-10'::date, 300, 0.19, 57, 357, 'Material',         'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'ANS-${TS}-EXP-2', 'Benzin',   '2026-05-05'::date, 150, 0.19, 28.5, 178.5, 'Kfz',              'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'ANS-${TS}-EXP-3', 'Berater',  '2026-04-20'::date, 200, 0.19, 38, 238, 'Steuerberatung',   'booked', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'ANS-${TS}-EXP-4', 'Sonstiges','2026-06-01'::date, 100, 0.19, 19, 119, 'Quatsch',          'booked', now(), now());
EOF

# ── 1. JSON shape ──
echo
note "=== 1. /anlage-s reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "anlage-s 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year','companyId','einnahmen','ausgaben','totals','counts','generatedAt','disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# 5 revenue + 13 expense lines
EINN=$(python3 -c "import json; print(len(json.load(open('$TMP'))['einnahmen']))")
AUSG=$(python3 -c "import json; print(len(json.load(open('$TMP'))['ausgaben']))")
assert_eq "5 revenue lines" "$EINN" "5"
assert_eq "13 expense lines" "$AUSG" "13"

# ── 2. Kz 4100 delta = 1000 - 200 (CN) = 800 ──
echo
note "=== 2. Kz 4100 delta = 800 (1000 - 200 CN) ==="
K4100_NOW=$(python3 -c "import json; d=json.load(open('$TMP')); print(next(l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'))")
K4100_DELTA=$(python3 -c "print(int(float('$K4100_NOW') - float('$BASE_K4100')))")
assert_eq "Kz 4100 delta = 800" "$K4100_DELTA" "800"

# ── 3. Other revenue lines all 0 (or unchanged) ──
echo
note "=== 3. Kz 4120/4135/4170/4190 unchanged from baseline ==="
ALL_ZERO=$(python3 -c "
import json
d = json.load(open('$TMP'))
others = [l['amount'] for l in d['einnahmen'] if l['kennziffer'] != '4100']
print('true' if all(v == 0 for v in others) else f'non-zero: {others}')
")
assert_eq "all other rev lines 0" "$ALL_ZERO" "true"

# ── 4. Expense mapping deltas ──
echo
note "=== 4. Kz 4620 (Material) +300, 4660 (Kfz) +150, 4700 (Steuerberatung) +200, 4720 (Sonstige fallback) +100 ==="
EXP_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
m = {l['kennziffer']: l['amount'] for l in d['ausgaben']}
# Delta from baseline.
deltas = {
  '4620': m.get('4620', 0) - float('$BASE_4620'),
  '4660': m.get('4660', 0) - float('$BASE_4660'),
  '4700': m.get('4700', 0) - float('$BASE_4700'),
  '4720': m.get('4720', 0) - float('$BASE_4720'),
}
expected = {'4620': 300, '4660': 150, '4700': 200, '4720': 100}
ok = all(abs(deltas[k] - v) < 0.01 for k, v in expected.items())
print('true' if ok else f'got deltas {deltas}, expected {expected}')
")
assert_eq "expense mapping deltas correct" "$EXP_OK" "true"

# ── 5. Sum consistency: per-line = subtotal = grand total ──
echo
note "=== 5. sum consistency (delta from baseline) ==="
SUM_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
# Delta from baseline.
e_delta = d['totals']['einnahmenTotal'] - float('$BASE_K4100')
a_delta = d['totals']['ausgabenTotal'] - float('$BASE_TOTAL')
expected_rev_delta = 800.0  # 1000 - 200
expected_exp_delta = 750.0  # 300 + 150 + 200 + 100
# gewinn delta = rev delta - exp delta = 50
expected_gewinn_delta = expected_rev_delta - expected_exp_delta
base_gewinn = float('$BASE_K4100') - float('$BASE_TOTAL')
new_gewinn = d['totals']['gewinn']
ok = (
  abs(e_delta - expected_rev_delta) < 0.01 and
  abs(a_delta - expected_exp_delta) < 0.01 and
  abs(new_gewinn - (base_gewinn + expected_gewinn_delta)) < 0.01
)
print('true' if ok else f'rev_delta={e_delta} exp_delta={a_delta} new_gewinn={new_gewinn} base_gewinn={base_gewinn} expected_delta_gewinn={expected_gewinn_delta}')
")
assert_eq "totals + per-line sums + gewinn delta" "$SUM_OK" "true"

# ── 6. PDF endpoint ──
echo
note "=== 6. /anlage-s.pdf returns application/pdf ==="
PDF_RESP=$(curl -sS -o /tmp/anlages-tier80.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/accounting/anlage-s.pdf?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$PDF_RESP" | cut -d'|' -f1)
CT=$(echo "$PDF_RESP" | cut -d'|' -f2)
assert_eq "PDF 200" "$HTTP" "200"
assert_eq "PDF content-type" "$CT" "application/pdf"
MAGIC=$(head -c 4 /tmp/anlages-tier80.pdf | od -An -tx1 | tr -d ' \n')
assert_eq "PDF magic bytes (25 50 44 46)" "$MAGIC" "25504446"
rm -f /tmp/anlages-tier80.pdf

# ── 7. year validation ──
echo
note "=== 7. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 8. Cross-tenant → 401 ──
echo
note "=== 8. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-s?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 9. Missing companyId → 400 ──
echo
note "=== 9. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-s?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$TMP"
summary
exit $?
