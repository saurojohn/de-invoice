#!/usr/bin/env bash
# e2e 114: Tier 88 — E-Bilanz (XBRL).
#
# Validates the new /api/v1/accounting/ebilanz +
# /ebilanz.xml + /ebilanz.pdf endpoints. The
# eBilanz-in-xtml is a BMF VORSCHAU format for
# the year-end submission to ELSTER. v1 covers
# the positions we can compute from our data
# (Bilanz + G+V + Anlagenverzeichnis); the
# rest are placeholders for the Berater.
#
# Tests:
#   1. /ebilanz reachable + shape (positions
#      array + counts + mapping stats).
#   2. /ebilanz.xml returns valid XML
#      (parses with Python xml.etree).
#   3. XML contains the XBRL root + de-gcd
#      namespace + at least 14 fact positions
#      (the v1 cover).
#   4. Bilanz-Positionen (Forderungen, Verb.
#      L+L, Eigenkapital-Saldoposten) appear
#      with non-zero values from the test data.
#   5. G+V-Positionen (Umsatzerlöse, Personal,
#      Material) appear with non-zero values.
#   6. The trailing comment block lists the
#      BMF-placeholder positions the Berater
#      must fill (subscribedCapital +
#      manual.placeholder).
#   7. /ebilanz.pdf returns application/pdf
#      with %PDF magic bytes.
#   8. Year validation 1999, 2101 → 400.
#   9. Missing companyId → 400.
#  10. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="ebilanz-tier88-$TS"
echo "=== Test: E-Bilanz (test tag: $TEST_TAG) ==="

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
    "DELETE FROM \"Expense\" WHERE \"invoiceNumber\" IN ('T88-${TS}-PERS', 'T88-${TS}-MAT');" >/dev/null 2>&1
  echo "  cleanup: removed T88-${TS}-PERS / -MAT expenses"
}
trap cleanup EXIT

# Tier 361: step 5 asserts Personalaufwand > 0, which the report only has
# when the company booked a Personal-category expense in 2026. The
# developer database had one; the CI seed has none, so the assertion failed
# the first time the spec ran. Seed one (same shape as 112-tier86-bwa's
# Lohn fixture); cleanup removes it.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", description, \"invoiceDate\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", category, status, \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'T88-${TS}-PERS', 'Lohn', '2026-04-20'::date, 400, 0, 0, 400, 'Personal', 'booked', now(), now());" >/dev/null
pass "seeded Personal expense T88-${TS}-PERS (400 EUR, 2026)"
# Tier 445: likewise Materialaufwand > 0. It passed on CI only because 106 / 107
# fed their cleanup SQL to `docker exec` without -i, so it never ran and their
# Material fixtures stayed behind for this spec.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", description, \"invoiceDate\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", category, status, \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'T88-${TS}-MAT', 'Rohstoffe', '2026-04-20'::date, 300, 0.19, 57, 357, 'Material', 'booked', now(), now());" >/dev/null
pass "seeded Material expense T88-${TS}-MAT (300 EUR net, 2026)"

# ===== 1. /ebilanz reachable + shape =====
echo
echo "=== 1. /ebilanz shape (positions + counts) ==="
DATA=$(curl -sS \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
echo "  year: $(echo "$DATA" | python3 -c 'import json,sys; print(json.load(sys.stdin)["year"])')"
COUNT_TOTAL=$(echo "$DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['total'])")
COUNT_COMPUTED=$(echo "$DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['computed'])")
COUNT_PLACEHOLDER=$(echo "$DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['placeholder'])")
# Tier 97 (v2): the mapping table now has
# 52 positions spanning Bilanz-Aktiva,
# Bilanz-Passiva, G+V, Sonstige. The
# original v1 (tier 88) had 20 positions
# with 17 computed + 2 placeholder. v2
# expands the table to cover the BMF GCD
# 6.7 schema — most new positions are
# placeholders for the Berater.
assert_eq "total positions == 52 (tier 97 v2 expansion)" "$COUNT_TOTAL" "52"
assert_eq "computed positions == 23 (Bilanz + G+V + Anhang computed)" "$COUNT_COMPUTED" "23"
assert_eq "placeholder positions == 28 (Berater fills in ELSTER)" "$COUNT_PLACEHOLDER" "28"

# ===== 2. /ebilanz.xml valid XML =====
echo
echo "=== 2. /ebilanz.xml is well-formed XML ==="
XML=$(curl -sS \
  "$API/api/v1/accounting/ebilanz.xml?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
echo "  size: $(echo "$XML" | wc -c) bytes"
PARSE_RESULT=$(echo "$XML" | python3 -c "
import xml.etree.ElementTree as ET
import sys
try:
    root = ET.fromstring(sys.stdin.read())
    print('OK')
except ET.ParseError as e:
    print(f'ERROR: {e}')
")
assert_eq "XML parses with xml.etree" "$PARSE_RESULT" "OK"

# ===== 3. XML contains XBRL root + de-gcd namespace + 14+ facts =====
echo
echo "=== 3. XML structure (root + namespace + fact count) ==="
STRUCT=$(echo "$XML" | python3 -c "
import xml.etree.ElementTree as ET
import sys
root = ET.fromstring(sys.stdin.read())
tag = root.tag
# count facts (elements with contextRef)
facts = sum(1 for el in root.iter() if el.get('contextRef'))
# check de-gcd namespace present (the parsed
# tag is {http://www.xbrl.org/taxonomy/de/gcd/...}localname)
has_gcd = any('gcd' in (el.tag or '') for el in root.iter())
print(f'{tag}|{facts}|{has_gcd}')
")
ROOT_TAG=$(echo "$STRUCT" | cut -d'|' -f1)
FACT_COUNT=$(echo "$STRUCT" | cut -d'|' -f2)
HAS_GCD=$(echo "$STRUCT" | cut -d'|' -f3)
echo "  root: $ROOT_TAG"
echo "  facts: $FACT_COUNT"
echo "  has de-gcd elements: $HAS_GCD"
# Check that root is xbrl
case "$ROOT_TAG" in
  *xbrl*) echo "✓ root tag contains 'xbrl'" ;;
  *) echo "✗ root tag missing 'xbrl': $ROOT_TAG"; exit 1 ;;
esac
assert_eq "fact count >= 14" "$([ "$FACT_COUNT" -ge 14 ] && echo true || echo false)" "true"
assert_eq "has de-gcd elements" "$HAS_GCD" "True"

# ===== 4. Bilanz positions have non-zero values =====
echo
echo "=== 4. Bilanz-Positionen (Forderungen, Verb L+L, Saldoposten) ==="
BILANZ_CHECK=$(echo "$DATA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pos = {p['elementId']: p['value'] for p in d['positions']}
print(f\"{pos.get('de-gcd:bs.ass.currAssets.tradeReceivables', 0) > 0}|{pos.get('de-gcd:bs.liab.cred.tradeLiabilities', 0) != 0}|{('de-gcd:bs.equity.retainedEarnings' in pos)}\")
")
FORD_OK=$(echo "$BILANZ_CHECK" | cut -d'|' -f1)
VERB_OK=$(echo "$BILANZ_CHECK" | cut -d'|' -f2)
SALDO_OK=$(echo "$BILANZ_CHECK" | cut -d'|' -f3)
assert_eq "Forderungen > 0" "$FORD_OK" "True"
assert_eq "Verb. L+L non-zero" "$VERB_OK" "True"
assert_eq "Eigenkapital-Saldoposten present" "$SALDO_OK" "True"

# ===== 5. G+V positions have non-zero values =====
echo
echo "=== 5. G+V-Positionen (Umsatzerlöse, Personal, Material) ==="
GUV_CHECK=$(echo "$DATA" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pos = {p['elementId']: p['value'] for p in d['positions']}
print(f\"{pos.get('de-gcd:is.rev.netSales', 0) > 0}|{pos.get('de-gcd:is.exp.employeeBenef', 0) > 0}|{pos.get('de-gcd:is.exp.costOfMaterials', 0) > 0}\")
")
UMS_OK=$(echo "$GUV_CHECK" | cut -d'|' -f1)
PERS_OK=$(echo "$GUV_CHECK" | cut -d'|' -f2)
MAT_OK=$(echo "$GUV_CHECK" | cut -d'|' -f3)
assert_eq "Umsatzerlöse > 0" "$UMS_OK" "True"
assert_eq "Personalaufwand > 0" "$PERS_OK" "True"
assert_eq "Materialaufwand > 0" "$MAT_OK" "True"

# ===== 6. Trailing comment lists the BMF-placeholder positions =====
echo
echo "=== 6. Trailing comment lists placeholder positions ==="
# Tier 97 (v2): the placeholder block
# lists all BMF positions the Berater
# must fill in their ELSTER client. v1
# had only 2 placeholders (subscribedCapital
# + manual.placeholder). v2 has 28
# placeholders — the TODO block now
# spans Bilanz-Aktiva, Bilanz-Passiva,
# G+V, Sonstige.
HAS_SUBSCRIBED=$(echo "$XML" | grep -c "subscribedCapital")
HAS_LAGEBERICHT=$(echo "$XML" | grep -c "de-gcd:genInfo.lagebericht")
HAS_TODO=$(echo "$XML" | grep -c "TODO (manuell)")
# Count how many BMF positions the TODO
# block lists (lines starting with "  - de-gcd:").
# v1: 2 lines. v2: ~28 lines.
TODO_LINES=$(echo "$XML" | grep -c "^  - de-gcd:")
assert_eq "XML mentions subscribedCapital" "$([ "$HAS_SUBSCRIBED" -gt 0 ] && echo true || echo false)" "true"
assert_eq "XML mentions lagebericht placeholder" "$([ "$HAS_LAGEBERICHT" -gt 0 ] && echo true || echo false)" "true"
assert_eq "XML has TODO comment" "$([ "$HAS_TODO" -gt 0 ] && echo true || echo false)" "true"
assert_eq "TODO block has >= 20 BMF placeholders (v2)" "$([ "$TODO_LINES" -ge 20 ] && echo true || echo false)" "true"

# ===== 7. /ebilanz.pdf =====
echo
echo "=== 7. /ebilanz.pdf returns application/pdf + magic bytes ==="
PDF_HEAD=$(curl -sS -o /tmp/ebilanz-$TS.pdf -w "%{http_code}|%{content_type}" \
  "$API/api/v1/accounting/ebilanz.pdf?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/ebilanz-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type = application/pdf" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes (25 50 44 46)" "$PDF_MAGIC" "25504446"
rm -f /tmp/ebilanz-$TS.pdf

# ===== 8. Year validation =====
echo
echo "=== 8. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 9. Missing companyId =====
echo
echo "=== 9. Missing companyId → 400 ==="
STATUS_NOCO=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/ebilanz?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$STATUS_NOCO" "400"

# ===== 10. Cross-tenant =====
echo
echo "=== 10. Cross-tenant → 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

echo
summary
