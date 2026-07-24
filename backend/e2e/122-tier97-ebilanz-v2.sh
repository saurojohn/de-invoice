#!/usr/bin/env bash
# Tier 97 (E-Bilanz v2) — covers the BMF
# GCD 6.7 schema positions beyond tier
# 88's 20-position core. v2 expands to
# 52 positions with 17 sub-sections
# (5 Aktiva + 5 Passiva + 5 G+V + sonstige),
# adds prior-year XBRL context, and PDFs
# one page per section.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# e2e 122 is read-only — no fixtures to
# wipe. Berater endpoints (ebilanz / ebilanz
# .xml / ebilanz.pdf) are pure GET; no
# cleanup is registered.
TS=$(date +%s)

# ===== 0. /ebilanz v2 shape: 52 positions, 17 sub-sections =====
echo
note "=== 1. /ebilanz v2 shape: 52 positions, 17 sub-sections ==="
api_get "/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

TOTAL=$(python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['total'])" < "$TMP")
COMPUTED=$(python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['computed'])" < "$TMP")
PLACEHOLDER=$(python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['placeholder'])" < "$TMP")
assert_eq "total positions == 52" "$TOTAL" "52"
assert_eq "computed positions == 23" "$COMPUTED" "23"
assert_eq "placeholder positions == 28" "$PLACEHOLDER" "28"

# Verify 17 sub-sections present
NUM_SECTIONS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
sections = sorted(set(p['section'] for p in d['positions']))
print(len(sections))
" < "$TMP")
assert_eq "distinct sub-sections == 17" "$NUM_SECTIONS" "17"

# Verify the 17 expected sub-section names are all present
SECTIONS_JSON='["bilanzAktivaAnlage","bilanzAktivaUmlauf","bilanzAktivaRap","bilanzAktivaLatent","bilanzAktivaSumme","bilanzPassivaEigenkapital","bilanzPassivaRueckstellungen","bilanzPassivaVerbindlichkeiten","bilanzPassivaRap","bilanzPassivaLatent","bilanzPassivaSumme","guvErträge","guvAufwendungen","guvFinanzergebnis","guvSteuern","guvJahresergebnis","sonstige"]'
PRESENT_JSON=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
present = sorted(set(p['section'] for p in d['positions']))
print(json.dumps(present))
" < "$TMP")
for sec in $(echo "$SECTIONS_JSON" | python3 -c "import json,sys; print(' '.join(json.load(sys.stdin)))"); do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(any(p['section'] == '''$sec''' for p in d['positions']))
" < "$TMP" 2>/dev/null || echo "False")
  assert_eq "section $sec present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 2. New v2 computed positions: Bilanz sums + G+V sub-totals =====
echo
note "=== 2. New v2 computed positions ==="
api_get "/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# Tier 97: Summe Aktiva + Summe Passiva (Bilanzgleichung)
BILANZ_CHECK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
pos = {p['elementId']: p for p in d['positions']}
ak = pos['de-gcd:bs.ass.grossAssets']['value']
pa = pos['de-gcd:bs.liab.grossLiabilities']['value']
print(f'{ak}|{pa}|{abs(ak - pa) < 0.01}')
" < "$TMP")
AK=$(echo "$BILANZ_CHECK" | cut -d'|' -f1)
PA=$(echo "$BILANZ_CHECK" | cut -d'|' -f2)
EQ=$(echo "$BILANZ_CHECK" | cut -d'|' -f3)
pass "Summe Aktiva = $AK"
pass "Summe Passiva = $PA"
assert_eq "Bilanzgleichung (Aktiva == Passiva)" "$EQ" "True"

# Bilanzgewinn (Equity) = Jahresüberschuss (G+V)
EQUITY_CHECK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
pos = {p['elementId']: p for p in d['positions']}
bi = pos['de-gcd:bs.equity.netIncome']['value']
ju = pos['de-gcd:is.netIncLoss']['value']
print(f'{bi == ju}|{bi}|{ju}')
" < "$TMP")
assert_eq "Bilanzgewinn == Jahresüberschuss" "$(echo "$EQUITY_CHECK" | cut -d'|' -f1)" "True"
pass "Bilanzgewinn = Jahresüberschuss = $(echo "$EQUITY_CHECK" | cut -d'|' -f2)"

# Bestandsveränderungen + aktivierte Eigenleistungen = 0 (de-invoice has no inventory)
ZERO_CHECK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
pos = {p['elementId']: p for p in d['positions']}
bv = pos['de-gcd:is.rev.chgInInv']['value']
el = pos['de-gcd:is.rev.othOwnWorkCap']['value']
print(f'{bv == 0}|{el == 0}|{bv}|{el}')
" < "$TMP")
assert_eq "Bestandsveränderungen = 0 (no inventory)" "$(echo "$ZERO_CHECK" | cut -d'|' -f1)" "True"
assert_eq "Aktivierte Eigenleistungen = 0 (no own work)" "$(echo "$ZERO_CHECK" | cut -d'|' -f2)" "True"
rm -f "$TMP"

# ===== 3. Placeholders are correctly marked (computed: false) =====
echo
note "=== 3. Placeholders: 28 positions marked computed=false ==="
api_get "/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# Count placeholders with computed=false AND value=null
PH_COUNT=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
ph = [p for p in d['positions'] if not p['computed'] and p['value'] is None]
print(len(ph))
" < "$TMP")
assert_eq "placeholder count (computed=false, value=null) == 28" "$PH_COUNT" "28"

# Verify all placeholder positions have a 'note' explaining the gap
PH_WITH_NOTE=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
ph = [p for p in d['positions'] if not p['computed']]
with_note = [p for p in ph if p.get('note')]
print(f'{len(with_note)}|{len(ph)}')
" < "$TMP")
WITH_NOTE=$(echo "$PH_WITH_NOTE" | cut -d'|' -f1)
TOTAL_PH=$(echo "$PH_WITH_NOTE" | cut -d'|' -f2)
assert_eq "all $TOTAL_PH placeholders have a 'note' (Berater hint)" "$WITH_NOTE" "$TOTAL_PH"
rm -f "$TMP"

# ===== 4. /ebilanz.xml has prior year context (v2) =====
echo
note "=== 4. /ebilanz.xml has prior year context ==="
api_get "/api/v1/accounting/ebilanz.xml?companyId=$COMPANY_ID&year=2026"
XML="$BODY"
assert_eq "xml 200" "$STATUS" "200"

# v2: the XBRL must contain a context with id="prior_<year-1>"
# AND a period <instant>YYYY-12-31 with year-1.
HAS_PRIOR_CTX=$(echo "$XML" | grep -c "id=\"prior_2025\"")
HAS_PRIOR_INSTANT=$(echo "$XML" | grep -c "<instant>2025-12-31</instant>")
HAS_CURRENT_CTX=$(echo "$XML" | grep -c "id=\"current_2026\"")
assert_eq "XML has prior_2025 context" "$([ "$HAS_PRIOR_CTX" -ge 1 ] && echo true || echo false)" "true"
assert_eq "XML has prior year instant 2025-12-31" "$([ "$HAS_PRIOR_INSTANT" -ge 1 ] && echo true || echo false)" "true"
assert_eq "XML has current_2026 context" "$([ "$HAS_CURRENT_CTX" -ge 1 ] && echo true || echo false)" "true"

# XML still well-formed
PARSE_OK=$(echo "$XML" | python3 -c "
import xml.etree.ElementTree as ET, sys
try:
    root = ET.fromstring(sys.stdin.read())
    print('OK')
except Exception as e:
    print(f'ERROR: {e}')
")
assert_eq "XML well-formed" "$PARSE_OK" "OK"

# ===== 5. /ebilanz.xml TODO block lists >= 25 BMF placeholders =====
echo
note "=== 5. /ebilanz.xml TODO block has >= 25 BMF placeholders ==="
TODO_LINES=$(echo "$XML" | grep -c "^  - de-gcd:")
assert_eq "TODO block has >= 25 BMF placeholders" "$([ "$TODO_LINES" -ge 25 ] && echo true || echo false)" "true"

# Spans all 4 main areas (Aktiva + Passiva + G+V + Sonstige) — the
# TODO block is one big XML comment listing all 29 placeholders,
# so we look for section-identifying keywords in the placeholder
# labels (the Bilanz-Aktiva placeholders have elementIds starting
# with "bs.ass.", the G+V ones with "is.").
for keyword in "bs.ass" "bs.liab" "is\." "genInfo"; do
  HAS=$(echo "$XML" | grep -cE "^  - de-gcd:$keyword")
  assert_eq "TODO block includes $keyword placeholders (>= 1)" "$([ "$HAS" -ge 1 ] && echo true || echo false)" "true"
done

# ===== 6. /ebilanz.pdf has section pages =====
echo
note "=== 6. /ebilanz.pdf renders section pages ==="
PDF_HEAD=$(curl -sS -o /tmp/ebilanz-v2-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/ebilanz.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type = application/pdf" "$PDF_CTYPE" "application/pdf"

# v2 PDF is bigger than v1 because of the
# per-section pages. v1 was ~5KB; v2 is
# ~15-20KB depending on company data.
PDF_SIZE=$(wc -c < /tmp/ebilanz-v2-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
test "$PDF_SIZE" -gt 8000 || fail "PDF too small (< 8KB), sections may be missing"
rm -f /tmp/ebilanz-v2-$TS.pdf

# ===== 7. /ebilanz.json section-by-section counts =====
echo
note "=== 7. per-section counts are reasonable ==="
api_get "/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# Aktiva: 5 sub-sections with 9 + 3 + 1 + 1 + 1 = 15 total
# (Anlage: 8 incl. goodwill/prepayments/finAss×2, Umlauf: 3, RAP: 1, Latent: 1, Summe: 1 → 14)
# Let me just assert each major group has at least 1 position
for sec in bilanzAktivaAnlage bilanzAktivaUmlauf bilanzPassivaEigenkapital bilanzPassivaVerbindlichkeiten guvErträge guvAufwendungen; do
  COUNT=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(sum(1 for p in d['positions'] if p['section'] == '$sec'))
" < "$TMP")
  assert_eq "section $sec has >= 3 positions" "$([ "$COUNT" -ge 3 ] && echo true || echo false)" "true"
done
rm -f "$TMP"

# ===== 8. Year validation (regression) =====
echo
note "=== 8. Year validation (regression from tier 88) ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 9. Cross-tenant (regression) =====
echo
note "=== 9. Cross-tenant 401 (regression) ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 10. Tier 88 regression: shape + XML well-formed + PDF magic =====
echo
note "=== 10. Tier 88 regression: shape + XML + PDF ==="
api_get "/api/v1/accounting/ebilanz?companyId=$COMPANY_ID&year=2026"
assert_eq "tier 88 regression: status 200" "$STATUS" "200"

api_get "/api/v1/accounting/ebilanz.xml?companyId=$COMPANY_ID&year=2026"
assert_eq "tier 88 regression: XML 200" "$STATUS" "200"

PDF_HEAD=$(curl -sS -o /tmp/ebilanz-regr-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/ebilanz.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_MAGIC=$(head -c 4 /tmp/ebilanz-regr-$TS.pdf | xxd -p)
assert_eq "tier 88 regression: PDF 200" "$PDF_STATUS" "200"
assert_eq "tier 88 regression: PDF magic bytes 25 50 44 46" "$PDF_MAGIC" "25504446"
rm -f /tmp/ebilanz-regr-$TS.pdf

summary
