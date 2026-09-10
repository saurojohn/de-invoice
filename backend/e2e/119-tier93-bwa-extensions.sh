#!/usr/bin/env bash
# e2e 119: Tier 93 — BWA extensions (granular
# Sonstige + Steuern + Zinserträge).
#
# Validates the BWA now has 12 lines (was 7):
#   1000  Umsatzerlöse
#   1300  Sonstige betriebliche Erträge
#   2000  Materialaufwand
#   3000  Personalkosten
#   3100  Abschreibungen (AfA)
#   3200  Raumkosten                  [tier 93]
#   3300  Versicherungen              [tier 93]
#   3400  Werbung / Reise             [tier 93]
#   3500  Instandhaltung              [tier 93]
#   3600  Sonstige betriebliche Aufw. (catchall — shrunk)
#   4100  Zinserträge                 [tier 93, 0 in v1]
#   4200  Zinsaufwendungen
#   5000  Steuern vom Einkommen       [tier 93]
#   5100  Sonstige Steuern            [tier 93]
#
# Plus the new totals:
#   - finanzergebnisMonat/Ytd/VorjahresYtd
#   - steuernMonat/Ytd/VorjahresYtd
#   - jahresergebnisMonat/Ytd/VorjahresYtd
#
# Tests:
#   1. /reports/bwa returns 12 lines.
#   2. 3200 catches Miete-category expenses.
#   3. 3300 catches Versicherung.
#   4. 3400 catches Werbung.
#   5. 3500 catches Reparatur.
#   6. 5000 catches Gewerbesteuer.
#   7. 5100 catches Grundsteuer.
#   8. 3600 shrinks to ONLY the true catchall
#      (excludes the matched categories).
#   9. finanzergebnis = 4100 - 4200.
#  10. jahresergebnis = betriebsergebnis +
#      finanzergebnis - steuern.
#  11. PDF endpoint returns valid PDF.
#  12. Year/month validation.
#  13. Missing companyId → 400.
#  14. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="bwa-tier93-$TS"
TEST_YEAR=2028
TEST_MONTH=3
echo "=== Test: BWA extensions (test tag: $TEST_TAG) ==="

# Pre-cleanup
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"Expense\" WHERE notes LIKE 'T93-${TS}-%';" >/dev/null 2>&1

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Expense\" WHERE notes LIKE 'T93-${TS}-%';" >/dev/null 2>&1
  echo "  cleanup: removed T93-${TS}-* rows"
}
trap cleanup EXIT

# ===== Seed: 7 expenses in the test month =====
# Each one targets a different new BWA bucket:
#   Miete        → 3200 Raumkosten         (1500)
#   Versicherung → 3300 Versicherungen    (300)
#   Werbung      → 3400 Werbung/Reise      (200)
#   Reparatur    → 3500 Instandhaltung     (400)
#   Gewerbesteuer→ 5000 Steuern Einkommen  (2500)
#   Grundsteuer  → 5100 Sonstige Steuern   (800)
#   Schuldzins   → 4200 Zinsaufwendungen   (180)
# Plus one "Sonstiges" expense that should
# fall through to 3600 catchall (250).
TMP_SQL=$(mktemp -t bwa-ext-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
INSERT INTO "Expense" (id, "companyId", "supplierId", "invoiceNumber", description, "invoiceDate", "netAmount", "vatRate", "vatAmount", "grossAmount", category, "isIntraEU", "isReverseCharge", status, notes, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Miete',         '${TEST_YEAR}-${TEST_MONTH}-05', -1500, 0, 0, -1500, 'Miete',         false, false, 'booked', 'T93-${TS}-miete fixture',         now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Versicherung',  '${TEST_YEAR}-${TEST_MONTH}-10', -300,  0, 0, -300,  'Versicherung',  false, false, 'booked', 'T93-${TS}-versicherung fixture',  now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Werbung',       '${TEST_YEAR}-${TEST_MONTH}-12', -200,  0, 0, -200,  'Werbung',       false, false, 'booked', 'T93-${TS}-werbung fixture',       now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Reparatur',      '${TEST_YEAR}-${TEST_MONTH}-15', -400,  0, 0, -400,  'Reparatur',     false, false, 'booked', 'T93-${TS}-reparatur fixture',     now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Gewerbesteuer',  '${TEST_YEAR}-${TEST_MONTH}-20', -2500, 0, 0, -2500, 'Gewerbesteuer', false, false, 'booked', 'T93-${TS}-gewerbesteuer fixture', now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Grundsteuer',    '${TEST_YEAR}-${TEST_MONTH}-22', -800,  0, 0, -800,  'Grundsteuer',   false, false, 'booked', 'T93-${TS}-grundsteuer fixture',   now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Schuldzins',     '${TEST_YEAR}-${TEST_MONTH}-25', -180,  0, 0, -180,  'Schuldzins',    false, false, 'booked', 'T93-${TS}-schuldzins fixture',    now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', NULL, NULL, 'T93-${TS}-Sonstiges',      '${TEST_YEAR}-${TEST_MONTH}-28', -250,  0, 0, -250,  'Sonstiges',     false, false, 'booked', 'T93-${TS}-sonstiges fixture',     now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"
echo "  seeded 8 expenses for ${TEST_YEAR}-${TEST_MONTH} covering all 7 new buckets + 3600 catchall"

# ===== 1. /reports/bwa returns 14 lines =====
echo
echo "=== 1. BWA returns 14 lines ==="
RESP=$(curl -sS \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=$TEST_YEAR&month=$TEST_MONTH" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
LINE_COUNT=$(echo "$RESP" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))")
assert_eq "BWA line count" "$LINE_COUNT" "14"

# Extract a specific bucket's value
get_bucket() {
  local bucket="$1"
  local field="$2"
  echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for l in d['lines']:
    if l['bucket'] == '$bucket':
        print('{:.2f}'.format(l['$field']))
        sys.exit(0)
print('NOT_FOUND')
"
}

# ===== 2. 3200 Raumkosten = -1500 =====
B3200_M=$(get_bucket "3200" "monat")
assert_eq "3200 Raumkosten monat" "$B3200_M" "1500.00"

# ===== 3. 3300 Versicherungen = -300 =====
B3300_M=$(get_bucket "3300" "monat")
assert_eq "3300 Versicherungen monat" "$B3300_M" "300.00"

# ===== 4. 3400 Werbung / Reise = -200 =====
B3400_M=$(get_bucket "3400" "monat")
assert_eq "3400 Werbung monat" "$B3400_M" "200.00"

# ===== 5. 3500 Instandhaltung = -400 =====
B3500_M=$(get_bucket "3500" "monat")
assert_eq "3500 Instandhaltung monat" "$B3500_M" "400.00"

# ===== 6. 5000 Steuern vom Einkommen = -2500 =====
B5000_M=$(get_bucket "5000" "monat")
assert_eq "5000 Gewerbesteuer monat" "$B5000_M" "2500.00"

# ===== 7. 5100 Sonstige Steuern = -800 =====
B5100_M=$(get_bucket "5100" "monat")
assert_eq "5100 Grundsteuer monat" "$B5100_M" "800.00"

# ===== 8. 3600 Sonstige shrunk to true catchall (-250) =====
B3600_M=$(get_bucket "3600" "monat")
assert_eq "3600 Sonstige (catchall) monat" "$B3600_M" "250.00"

# ===== 9. finanzergebnis = 4100 - 4200 = 0 - 180 = -180 =====
FIN_M=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('{:.2f}'.format(d['totals']['finanzergebnisMonat']))
")
assert_eq "finanzergebnisMonat" "$FIN_M" "-180.00"

# ===== 10. jahresergebnis = betriebsergebnis + finanz - steuern =====
# All other lines are 0 in this test (no
# invoices, no other expenses), so:
#   betriebsergebnis = -(3200+3300+3400+3500+3600)
#                    = -(1500+300+200+400+250) = -2650
#   finanzergebnis  = 0 - 180 = -180
#   steuern         = 2500 + 800 = 3300
#   jahresergebnis  = -2650 + -180 - 3300 = -6130
# (joke math — verifies all 3 totals + the
# line-sum match the bottom line)
BETR_M=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('{:.2f}'.format(d['totals']['betriebsergebnisMonat']))
")
STEUERN_M=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('{:.2f}'.format(d['totals']['steuernMonat']))
")
JERG_M=$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('{:.2f}'.format(d['totals']['jahresergebnisMonat']))
")
assert_eq "betriebsergebnisMonat" "$BETR_M" "-2650.00"
assert_eq "steuernMonat" "$STEUERN_M" "3300.00"
# Verify the identity: jahresergebnis = betr + fin - steuern
JERG_CALC=$(python3 -c "
import sys
b = float('$BETR_M')
f = float('$FIN_M')
s = float('$STEUERN_M')
print('{:.2f}'.format(round(b + f - s, 2)))
")
assert_eq "jahresergebnisMonat = betr + fin - steuern" "$JERG_CALC" "$JERG_M"

# ===== 11. PDF endpoint =====
echo
echo "=== 11. /reports/bwa.pdf returns valid PDF ==="
PDF_BYTES=$(curl -sS \
  "$API/api/v1/reports/bwa.pdf?companyId=$COMPANY_ID&year=$TEST_YEAR&month=$TEST_MONTH" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -o /tmp/bwa-ext.pdf -w "%{http_code}")
assert_eq "PDF endpoint 200" "$PDF_BYTES" "200"
PDF_MAGIC=$(head -c 4 /tmp/bwa-ext.pdf)
assert_eq "PDF magic bytes" "$PDF_MAGIC" "%PDF"

# ===== 12. Year / month validation =====
echo
echo "=== 12. Year / month validation ==="
S1=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=1999&month=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$S1" "400"
S2=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=13" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "month=13 → 400" "$S2" "400"
S3=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=2026&month=0" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "month=0 → 400" "$S3" "400"

# ===== 13. Missing companyId =====
echo
echo "=== 13. Missing companyId → 400 ==="
S4=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?year=$TEST_YEAR&month=$TEST_MONTH" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$S4" "400"

# ===== 14. Cross-tenant =====
echo
echo "=== 14. Cross-tenant → 401 ==="
S5=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/bwa?companyId=$COMPANY_ID&year=$TEST_YEAR&month=$TEST_MONTH" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "cross-tenant → 401" "$S5" "401"

echo
summary
