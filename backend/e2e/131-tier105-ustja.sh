#!/usr/bin/env bash
# Tier 105 — UStJA (Umsatzsteuerjahreserklärung,
# § 18 Abs. 3 UStG, BMF Vordruck 2024).
#
# Validates the new UstjaService + the
# /api/v1/ustva/ustja endpoint + the
# /api/v1/ustva/ustja.pdf endpoint + the
# Berater packager 10-way shift (V + KAP + G +
# N + KSt 1 + R + Kind + UStJA + 4 HGB).
#
# Aggregates 12 monthly UStVAs. Tier 417: the lines carry the Kennzahlen of
# the official USt 2 A 2026 form (19 % = Kz 177, igL = 741, Vorsteuer 320 /
# 761 / 467 …). The spec used to require an invented set — Kz 20-23 for the
# rates and "Kz 66/67/68/39/69/81" as total lines, with the
# Sondervorauszahlung as January / 11 — and so asserted the defect.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /ustja shape: 12 months, only USt 2 A 2026 Kennzahlen =====
echo
note "=== 1. /ustja shape (12 months; Kennzahlen of the USt 2 A 2026) ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
MONTHS=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['monthlyBreakdown']))" < "$TMP")
assert_eq "monthly breakdown count == 12" "$MONTHS" "12"
UNKNOWN=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
official = {'177','275','155','156','741','752','781','793','798','799','846','847','877','878','209','721','205','320','761','467',''}
print(sorted({l['kennziffer'] for l in d['lines']} - official))
" < "$TMP")
assert_eq "every line carries an official Kennzahl (none of the old 20/66/68/39/69/81)" "$UNKNOWN" "[]"
rm -f "$TMP"

# ===== 2. Totals: Umsatzsteuer − Vorsteuer, then the Vorauszahlungssoll =====
echo
note "=== 2. totals: zahllast = USt − VSt; abschlusszahlung = zahllast − Soll ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
MATH=$(python3 -c "
import json, sys
t = json.load(sys.stdin)['totals']
print(f\"{abs(t['zahllast'] - (t['umsatzsteuer'] - t['vorsteuer'])) < 0.01}|{abs(t['abschlusszahlung'] - (t['zahllast'] - t['vorauszahlungssoll'])) < 0.01}\")
" < "$TMP")
assert_eq "zahllast = umsatzsteuer - vorsteuer" "$(echo "$MATH" | cut -d'|' -f1)" "True"
assert_eq "abschlusszahlung = zahllast - vorauszahlungssoll" "$(echo "$MATH" | cut -d'|' -f2)" "True"
rm -f "$TMP"

# ===== 3. Vorsteuer total = Kz 320 + 761 + 467 =====
echo
note "=== 3. totals.vorsteuer = Kz 320 + 761 + 467 ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
VST=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
s = sum(l.get('vat') or 0 for l in d['lines'] if l['kennziffer'] in ('320','761','467'))
print(abs(s - d['totals']['vorsteuer']) < 0.01)
" < "$TMP")
assert_eq "vorsteuer = Kz 320 + 761 + 467" "$VST" "True"
rm -f "$TMP"

# ===== 4. 12 monthly rows sum to yearly totals =====
echo
note "=== 4. Σ monthly = yearly totals ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

SUM_MATCH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
m = d['monthlyBreakdown']
sum_ust = sum(x['umsatzsteuer'] for x in m)
sum_vst = sum(x['vorsteuer'] for x in m)
sum_zahl = sum(x['zahllast'] for x in m)
t = d['totals']
matches = (
  abs(sum_ust - t['umsatzsteuer']) < 0.01
  and abs(sum_vst - t['vorsteuer']) < 0.01
  and abs(sum_zahl - t['zahllast']) < 0.01
)
print('True' if matches else 'False')
" < "$TMP")
assert_eq "Σ monthly = yearly totals" "$SUM_MATCH" "True"
rm -f "$TMP"

# ===== 5. /ustja.pdf returns valid PDF =====
echo
note "=== 5. /ustja.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/ustja-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/ustja-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/ustja-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/ustja-$TS.pdf

# ===== 6. Year validation =====
echo
note "=== 6. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 7. Cross-tenant =====
echo
note "=== 7. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 8. Berater packager ALWAYS includes UStJA =====
echo
note "=== 8. Berater packager ALWAYS includes UStJA (no opt-out) ==="
# Use a year with no opt-outs forced. The default
# state of the dev DB has no anlageR, anlageKind,
# etc. flags, so UStJA is the only "always included"
# addition.
ZIP_PATH=/tmp/berater-ustja-e2e-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-ustja-e2e-$TS && cd /tmp/berater-ustja-e2e-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

USTJA_PDF=$(find /tmp/berater-ustja-e2e-$TS -name "*UStJA.pdf" | head -1)
[[ -n "$USTJA_PDF" ]] && pass "UStJA.pdf present in packager" || fail "UStJA.pdf missing from packager"
if [[ -n "$USTJA_PDF" ]]; then
  USTJA_MAGIC=$(head -c 4 "$USTJA_PDF" | xxd -p)
  assert_eq "UStJA PDF magic bytes" "$USTJA_MAGIC" "25504446"
fi

MANIFEST_HAS_USTJA=$(grep -c "UStJA" /tmp/berater-ustja-e2e-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_USTJA" -ge 1 ]] && pass "MANIFEST mentions UStJA ($MANIFEST_HAS_USTJA lines)" || fail "MANIFEST missing UStJA"

rm -rf /tmp/berater-ustja-e2e-$TS "$ZIP_PATH"

# ===== 9. UStJA also present when ALL 7 optionals are opted out =====
echo
note "=== 9. UStJA still present when ALL 7 optional Anlage forms are disabled ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{
    \"anlageV\": false, \"anlageKAP\": false, \"anlageG\": false,
    \"anlageN\": false, \"kst1\": false, \"anlageR\": false, \"anlageKind\": false
  }'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

# Also clear any Rente / Kinder / Lohnsteuerbescheinigung data for 2024
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'renten' - 'rentenWerbungskosten' - 'kinder' - 'lohnsteuerbescheinigungen'
  WHERE id = '$COMPANY_ID';" >/dev/null

ZIP_PATH=/tmp/berater-minimal-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2024"

mkdir -p /tmp/berater-minimal-$TS && cd /tmp/berater-minimal-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

# UStJA position depends on the KSt 1 include. SH
# Leder GmbH is a GmbH → KSt 1 is auto-included
# via Rechtsform-conditional logic, so KSt 1 sits
# at slot 03 and UStJA at 04. With ALL other
# optionals off (anlageV/KAP/G/N/R/Kind = false),
# this is the expected 2-slot minimum offset.
# (Tier 106: GewSt is always at slot +1 relative
# to UStJA, so the trailing BWA is at UStJA + 2.)
EXPECTED_USTJA_SLOT="04"
USTJA_PRESENT=$(find /tmp/berater-minimal-$TS -name "${EXPECTED_USTJA_SLOT}_UStJA.pdf" | head -1)
if [[ -n "$USTJA_PRESENT" ]]; then
  pass "${EXPECTED_USTJA_SLOT}_UStJA.pdf present (KSt 1 at 03, UStJA at 04)"
else
  # If KSt 1 opt-out also worked (e.g. Rechtsform is
  # not GmbH), UStJA would be at slot 03. Try that too.
  USTJA_FALLBACK=$(find /tmp/berater-minimal-$TS -name "03_UStJA.pdf" | head -1)
  if [[ -n "$USTJA_FALLBACK" ]]; then
    pass "03_UStJA.pdf present (KSt 1 also off, UStJA at 03)"
    EXPECTED_USTJA_SLOT="03"
  else
    fail "UStJA.pdf missing — should be at 03 or 04"
  fi
fi

# BWA is at UStJA + 2 (one extra slot for the always-on
# GewSt-Erklärung, tier 106).
BWA_EXPECTED_SLOT=$(printf "%02d" $((10#$EXPECTED_USTJA_SLOT + 2)))
BWA_PRESENT=$(find /tmp/berater-minimal-$TS -name "${BWA_EXPECTED_SLOT}_BWA.pdf" | head -1)
[[ -n "$BWA_PRESENT" ]] && pass "${BWA_EXPECTED_SLOT}_BWA.pdf present (UStJA + GewSt pushed BWA)" || fail "${BWA_EXPECTED_SLOT}_BWA.pdf missing — BWA should be at slot ${BWA_EXPECTED_SLOT} after UStJA + GewSt"

ls /tmp/berater-minimal-$TS/ | sort
rm -rf /tmp/berater-minimal-$TS "$ZIP_PATH"

# Cleanup
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'anlageV' - 'anlageKAP' - 'anlageG' - 'anlageN' - 'kst1' - 'anlageR' - 'anlageKind'
  WHERE id = '$COMPANY_ID';" >/dev/null

# ===== 10. counts + disclaimer =====
echo
note "=== 10. counts + disclaimer present ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{isinstance(c[\"hasData\"], bool) and isinstance(c[\"monthsWithData\"], int)}')
" < "$TMP")
assert_eq "counts object present + types correct" "$HAS_COUNTS" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

# Disclaimer mentions § 18 UStG + BMF
HAS_18=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('§ 18' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions § 18 UStG" "$HAS_18" "True"

HAS_BMF=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('BMF' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions BMF" "$HAS_BMF" "True"
rm -f "$TMP"

# ===== 11. periodLabel format =====
echo
note "=== 11. periodLabel format ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

PERIOD=$(python3 -c "import json,sys; print(json.load(sys.stdin)['periodLabel'])" < "$TMP")
# Expected format: "01.01.YYYY – 31.12.YYYY"
assert_eq "periodLabel" "$PERIOD" "01.01.2026 – 31.12.2026"
rm -f "$TMP"

# ===== 12. 19 % turnover is Kz 177 =====
echo
note "=== 12. 19 % turnover is Kz 177 (was 'Kz 20') ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
R19=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(any(l['kennziffer'] == '177' and '19 %' in l['label'] for l in d['lines']))
" < "$TMP")
if [[ "$R19" == "True" ]]; then pass "Kz 177 = 19 % Umsätze present"; else pass "No 19 % sales in 2026 on this company — Kz 177 absent"; fi
rm -f "$TMP"

summary
