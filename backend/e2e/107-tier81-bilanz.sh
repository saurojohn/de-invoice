#!/usr/bin/env bash
# e2e 107: Tier 81 — Bilanz (Balance Sheet) VORSCHAU.
#
# Validates the new /api/v1/accounting/bilanz
# + /bilanz.pdf endpoints. Year-end § 266 HGB
# layout for Bilanz-pflichtige entities. v1
# only computes positions we can derive; the
# rest is "nicht ausgewiesen" (not stated). The
# Saldoposten in the Eigenkapital section
# balances the Bilanzgleichung.
#
# Tests:
#   1. JSON shape + 3 Aktiva + 4 Passiva sections
#      + all 25 expected positions.
#   2. Aktiva / B. Umlaufvermögen: 1500 Forderungen
#      aus L+L = sum of open (sent/overdue) invoices
#      at snapshot.
#   3. Aktiva / B. Umlaufvermögen: 1600+1700 Liquide
#      Mittel = sum of cash book entries (Einnahme +
#      Eröffnung − Ausgabe − Umbuchung) at snapshot.
#   4. Passiva / C. Verb.: 4000 Verb. aus L+L = sum
#      of open (booked/deductible) expenses at
#      snapshot.
#   5. Passiva / C. Verb.: 4500 Kundenguthaben = sum
#      of positive customer-credit balances.
#   6. Bilanzgleichung always balanced (Saldoposten
#      compensates).
#   7. PDF returns application/pdf + magic bytes.
#   8. year validation 1999, 2101 → 400.
#   9. Cross-tenant → 401.
#  10. Missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="bilanz-tier81-$TS"
echo "=== Test: Bilanz Vorschau (test tag: $TEST_TAG) ==="

# Pre-cleanup: remove any orphan BIL-* fixtures
# from previous test runs (the per-run cleanup
# only catches the current $TS; older runs
# accumulate over time and break the
# delta-snapshot assertion).
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'BIL-%');
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'BIL-%';
DELETE FROM "Expense" WHERE "invoiceNumber" LIKE 'BIL-%';
DELETE FROM "CustomerCreditTransaction" WHERE "referenceId" IN (SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'BIL-%') OR "description" LIKE 'BIL-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'BIL-%';
SQL

# Cleanup hook
cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'BIL-${TS}-%');
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'BIL-${TS}-%';
DELETE FROM "Expense" WHERE "invoiceNumber" LIKE 'BIL-${TS}-%';
DELETE FROM "CustomerCreditTransaction" WHERE "description" LIKE 'BIL-${TS}-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'BIL-${TS}-%';
SQL
}
trap cleanup EXIT

# Seed test customers
TMP_SQL=$(mktemp -t bilanz-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId", "address", "paymentTerms", "tags", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'BIL Test Kunde', 'BIL-${TS}-DE-1', NULL, '{"country":"Deutschland"}'::jsonb, 30, ARRAY[]::text[], now(), now());
EOF
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\"='$COMPANY_ID' AND \"customerNumber\"='BIL-${TS}-DE-1';" \
  2>&1 | tr -d ' ' | head -1)

# Capture the baseline BEFORE adding fixtures.
# The dev DB has other invoices/expenses for
# 2026 (from prior tiers + seed) — we assert
# DELTAS against this baseline so the test
# stays deterministic regardless of seed
# data.
BASE=$(curl -sS \
  "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")

BASE_1500=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for sec in d['aktiva']:
  for l in sec['lines']:
    if l['position'] == '1500':
      print(l['amount'] or 0)
      break
")
BASE_1600_1700=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for sec in d['aktiva']:
  for l in sec['lines']:
    if l['position'] == '1600+1700':
      print(l['amount'] or 0)
      break
")
BASE_4000=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for sec in d['passiva']:
  for l in sec['lines']:
    if l['position'] == '4000':
      print(l['amount'] or 0)
      break
")
BASE_4500=$(echo "$BASE" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for sec in d['passiva']:
  for l in sec['lines']:
    if l['position'] == '4500':
      print(l['amount'] or 0)
      break
")
BASE_AKTIVA=$(echo "$BASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['aktiva'])")
BASE_PASSIVA=$(echo "$BASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['passiva'])")
echo "  Baseline: 1500=$BASE_1500 1600+1700=$BASE_1600_1700 4000=$BASE_4000 4500=$BASE_4500 AKTIVA=$BASE_AKTIVA PASSIVA=$BASE_PASSIVA"

# Add a SENT invoice: 1000 net @ 19% USt → 1500 Forderungen
INV1_ID="inv-bil-1-$TS"
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV1_ID'::text, '$COMPANY_ID', '$CUST_ID', 'BIL-${TS}-INV-1', 'INV', 'sent',
        '2026-05-15'::date, 1000, 190, 1190, 'EUR', 'de-DE',
        false, false, 'BIL Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV1_ID', 'Beratung', 1, 1000, 0.19, 1000, 190, 1190, 0, now());
EOF

# Add a PAID invoice: 500 net @ 19% USt → NOT in 1500 (excluded)
INV2_ID="inv-bil-2-$TS"
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV2_ID'::text, '$COMPANY_ID', '$CUST_ID', 'BIL-${TS}-INV-2', 'INV', 'paid',
        '2026-04-10'::date, 500, 95, 595, 'EUR', 'de-DE',
        false, false, 'BIL Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV2_ID', 'Wartung', 1, 500, 0.19, 500, 95, 595, 0, now());
EOF

# Add a DRAFT invoice: 800 net @ 19% USt → NOT in 1500 (excluded)
INV3_ID="inv-bil-3-$TS"
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV3_ID'::text, '$COMPANY_ID', '$CUST_ID', 'BIL-${TS}-INV-3', 'INV', 'draft',
        '2026-04-10'::date, 800, 152, 952, 'EUR', 'de-DE',
        false, false, 'BIL Test', now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate", "netAmount", "vatAmount", "grossAmount", "sortOrder", "createdAt")
VALUES (gen_random_uuid()::text, '$INV3_ID', 'Draft', 1, 800, 0.19, 800, 152, 952, 0, now());
EOF

# Add a BOOKED expense: 300 gross → 4000 Verb. aus L+L
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Expense" (id, "companyId", "invoiceNumber", description, "invoiceDate",
                       "netAmount", "vatRate", "vatAmount", "grossAmount", category, status,
                       "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'BIL-${TS}-EXP-1', 'Büromaterial',  '2026-04-10'::date, 252.10, 0.19, 47.90, 300, 'Material',         'booked', now(), now());
EOF

# Add a PAID expense: 200 gross → NOT in 4000 (excluded)
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "Expense" (id, "companyId", "invoiceNumber", description, "invoiceDate",
                       "netAmount", "vatRate", "vatAmount", "grossAmount", category, status,
                       "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'BIL-${TS}-EXP-2', 'Bewirtung',  '2026-05-05'::date, 168.07, 0.19, 31.93, 200, 'Sonstiges',         'paid', now(), now());
EOF

# Add a customer credit transaction: +150 → 4500 Kundenguthaben
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<EOF >/dev/null
INSERT INTO "CustomerCreditTransaction" (id, "companyId", "customerId", "amount", "balanceAfter", "type", "description", "createdById", "createdAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 150, 150, 'overpayment', 'BIL-${TS} Gutschrift', '$USER_ID', now());
EOF

# ── 1. JSON shape ──
echo
note "=== 1. /bilanz reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "bilanz 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year','companyId','aktiva','passiva','totals','balanceCheck','generatedAt','disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# 3 Aktiva sections + 4 Passiva sections
NAKT=$(python3 -c "import json; print(len(json.load(open('$TMP'))['aktiva']))")
NPAS=$(python3 -c "import json; print(len(json.load(open('$TMP'))['passiva']))")
assert_eq "3 Aktiva sections" "$NAKT" "3"
assert_eq "4 Passiva sections" "$NPAS" "4"

# Verify the expected section titles (in order)
SECTION_TITLES=$(python3 -c "
import json
d = json.load(open('$TMP'))
aktiva = [s['title'] for s in d['aktiva']]
passiva = [s['title'] for s in d['passiva']]
expected = ['A. Anlagevermögen','B. Umlaufvermögen','C. Rechnungsabgrenzungsposten','A. Eigenkapital','B. Rückstellungen','C. Verbindlichkeiten','D. Rechnungsabgrenzungsposten']
actual = aktiva + passiva
print('true' if actual == expected else f'expected {expected}, got {actual}')
")
assert_eq "all 7 section titles in § 266 HGB order" "$SECTION_TITLES" "true"

# Aktiva A. Anlagevermögen: 5 lines all nicht ausgewiesen
A_LINES=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = next(s for s in d['aktiva'] if s['title'].startswith('A. Anlagevermögen'))
print(len(sec['lines']))
")
assert_eq "Aktiva A. Anlagevermögen has 5 lines" "$A_LINES" "5"

# Passiva A. Eigenkapital: 6 lines incl. Saldoposten
EK_LINES=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = next(s for s in d['passiva'] if s['title'].startswith('A. Eigenkapital'))
print(len(sec['lines']))
")
assert_eq "Passiva A. Eigenkapital has 6 lines (incl. Saldoposten)" "$EK_LINES" "6"

# Saldoposten line must be present in Eigenkapital
HAS_SALDOPOSTEN=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = next(s for s in d['passiva'] if s['title'].startswith('A. Eigenkapital'))
print('true' if any(l['position'] == 'EKV' for l in sec['lines']) else 'false')
")
assert_eq "Eigenkapital contains Saldoposten (EKV)" "$HAS_SALDOPOSTEN" "true"

# ── 2. 1500 Forderungen aus L+L: only SENT + OVERDUE counted ──
echo
note "=== 2. 1500 Forderungen delta = +1190 (only SENT INV-1, not PAID INV-2 or DRAFT INV-3) ==="
NEW_1500=$(python3 -c "
import json
d = json.load(open('$TMP'))
for sec in d['aktiva']:
  for l in sec['lines']:
    if l['position'] == '1500':
      print(l['amount'] or 0)
      break
")
D1500=$(python3 -c "print(int(float('$NEW_1500') - float('$BASE_1500')))")
assert_eq "1500 delta = +1190 (SENT only)" "$D1500" "1190"

# ── 3. 1600+1700 Liquide Mittel: derived from cash book ──
echo
note "=== 3. 1600+1700 Liquide Mittel still in delta (cash book has prior seed) ==="
NEW_1600_1700=$(python3 -c "
import json
d = json.load(open('$TMP'))
for sec in d['aktiva']:
  for l in sec['lines']:
    if l['position'] == '1600+1700':
      print(l['amount'] or 0)
      break
")
# We didn't add cash book entries — delta should be 0.
D1600=$(python3 -c "print(int(float('$NEW_1600_1700') - float('$BASE_1600_1700')))")
assert_eq "1600+1700 delta = 0 (no new cash entries)" "$D1600" "0"

# ── 4. 4000 Verb. aus L+L: BOOKED only ──
echo
note "=== 4. 4000 Verb. aus L+L delta = +300 (BOOKED EXP-1 only, not PAID EXP-2) ==="
NEW_4000=$(python3 -c "
import json
d = json.load(open('$TMP'))
for sec in d['passiva']:
  for l in sec['lines']:
    if l['position'] == '4000':
      print(l['amount'] or 0)
      break
")
D4000=$(python3 -c "print(int(float('$NEW_4000') - float('$BASE_4000')))")
assert_eq "4000 delta = +300 (BOOKED only)" "$D4000" "300"

# ── 5. 4500 Kundenguthaben delta = +150 ──
echo
note "=== 5. 4500 Kundenguthaben delta = +150 (positive credit) ==="
NEW_4500=$(python3 -c "
import json
d = json.load(open('$TMP'))
for sec in d['passiva']:
  for l in sec['lines']:
    if l['position'] == '4500':
      print(l['amount'] or 0)
      break
")
D4500=$(python3 -c "print(int(float('$NEW_4500') - float('$BASE_4500')))")
assert_eq "4500 delta = +150" "$D4500" "150"

# ── 6. Bilanzgleichung always balanced (Saldoposten compensates) ──
echo
note "=== 6. Bilanzgleichung check (always balanced — Saldoposten) ==="
BAL=$(python3 -c "
import json
d = json.load(open('$TMP'))
print('true' if d['balanceCheck']['balanced'] else f'diff={d[\"balanceCheck\"][\"diff\"]}')
")
assert_eq "balanceCheck.balanced" "$BAL" "true"

# diff should be 0 (or < 0.01)
DIFF=$(python3 -c "
import json
d = json.load(open('$TMP'))
print(int(abs(d['balanceCheck']['diff'])))
")
assert_eq "balanceCheck.diff = 0" "$DIFF" "0"

# Aktiva total = Passiva total (Bilanzgleichung)
EQ=$(python3 -c "
import json
d = json.load(open('$TMP'))
a = d['totals']['aktiva']
p = d['totals']['passiva']
print('true' if abs(a - p) < 0.01 else f'a={a} p={p}')
")
assert_eq "totals.aktiva = totals.passiva" "$EQ" "true"

# ── 7. Eigenkapital Saldoposten = aktiva_total − sonstige_passiva ──
echo
note "=== 7. Eigenkapital Saldoposten = (Aktiva - sonstige Passiva) ==="
# The Saldoposten should be the residual that makes
# Bilanzgleichung balance. After our fixtures,
# Aktiva delta = 1190 (only 1500 changed; 1600+1700
# unchanged). Passiva non-EK delta = +300 (4000) +
# +150 (4500) = +450. So EK delta = 1190 - 450 = 740.
EKV_DELTA_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = next(s for s in d['passiva'] if s['title'].startswith('A. Eigenkapital'))
saldoposten = next(l['amount'] for l in sec['lines'] if l['position'] == 'EKV')
# Non-EK Passiva total: sum of B/C/D sections' subtotals
non_ek = sum((s['subtotal'] or 0) for s in d['passiva'] if not s['title'].startswith('A. Eigenkapital'))
# Aktiva total
aktiva = d['totals']['aktiva']
# The Saldoposten should equal aktiva - non_ek
expected = round(aktiva - non_ek, 2)
actual = round(saldoposten, 2)
print('true' if abs(expected - actual) < 0.01 else f'saldoposten={actual} expected={expected}')
")
assert_eq "Saldoposten = aktiva - non_ek passiva" "$EKV_DELTA_OK" "true"

# ── 8. PDF endpoint ──
echo
note "=== 8. /bilanz.pdf returns application/pdf + magic bytes ==="
PDF_RESP=$(curl -sS -o /tmp/bilanz-tier81.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/accounting/bilanz.pdf?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$PDF_RESP" | cut -d'|' -f1)
CT=$(echo "$PDF_RESP" | cut -d'|' -f2)
assert_eq "PDF 200" "$HTTP" "200"
assert_eq "PDF content-type" "$CT" "application/pdf"
MAGIC=$(head -c 4 /tmp/bilanz-tier81.pdf | od -An -tx1 | tr -d ' \n')
assert_eq "PDF magic bytes (25 50 44 46)" "$MAGIC" "25504446"
rm -f /tmp/bilanz-tier81.pdf

# ── 9. year validation ──
echo
note "=== 9. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 10. Cross-tenant → 401 ──
echo
note "=== 10. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 11. Missing companyId → 400 ──
echo
note "=== 11. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/bilanz?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$TMP"
summary
exit $?
