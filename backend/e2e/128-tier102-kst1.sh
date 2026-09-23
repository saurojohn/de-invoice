#!/usr/bin/env bash
# Tier 102 — KSt 1 (Körperschaftsteuererklärung,
# § 1 Abs. 1 KStG).
#
# Validates the new KSt1Service + the
# /api/v1/accounting/kst1 endpoint + the
# /api/v1/accounting/kst1.pdf endpoint +
# the Berater packager 7-way conditional shift
# (V + KAP + G/N + KSt 1 — mutually exclusive
# with Anlage G for Kapitalgesellschaften).
#
# v1: reads the G+V Jahresüberschuss from
# GuVService and applies the standard KSt +
# Soli + GewSt + Anrechnung formula. KSt-
# Korrekturen (vGAs, Spenden, Verlustabzug)
# are placeholder for the Berater.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /kst1 shape: 8 Korrekturen + 5 bottom-line numbers =====
echo
note "=== 1. /kst1 shape (8 Korrekturen + 5 totals) ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

K=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['corrections']))" < "$TMP")
assert_eq "corrections count == 8" "$K" "8"

# Verify all expected bottom-line fields
SHAPE=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
required = ['jahresueberschuss', 'zve', 'kst', 'soli', 'gewstMessbetrag', 'hebesatz', 'gewst', 'zuZahlen']
missing = [k for k in required if k not in d['totals']]
print('OK' if not missing else f'MISSING: {missing}')
" < "$TMP")
assert_eq "all bottom-line fields present" "$SHAPE" "OK"
rm -f "$TMP"

# ===== 2. Key Kennziffern present in Korrekturen =====
echo
note "=== 2. Key Korrekturen Kz (30, 40, 50, 60, 80) ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

for kz in 30 31 40 50 60 70 80 90; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(any(l['kennziffer'] == '$kz' for l in d['corrections']))
" < "$TMP")
  assert_eq "Korrektur Kz $kz present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 3. Rechtsform = GmbH (default), isKapitalgesellschaft = True =====
echo
note "=== 3. Rechtsform GmbH → isKapitalgesellschaft True ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

RECHTSFORM=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rechtsform'])" < "$TMP")
IS_KAP=$(python3 -c "import json,sys; print(json.load(sys.stdin)['isKapitalgesellschaft'])" < "$TMP")
assert_eq "rechtsform == GmbH" "$RECHTSFORM" "GmbH"
assert_eq "isKapitalgesellschaft == True" "$IS_KAP" "True"
rm -f "$TMP"

# ===== 4. Math identities: KSt = 15% × ZvE, Soli = 5.5% × KSt, GewSt = 3.5% × ZvE × Hebesatz/100 =====
echo
note "=== 4. KSt = 15% × ZvE, Soli = 5.5% × KSt, GewSt-Messbetrag = 3.5% × ZvE ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

MATH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
zve = d['totals']['zve']
kst = d['totals']['kst']
soli = d['totals']['soli']
gewst = d['totals']['gewst']
messbetrag = d['totals']['gewstMessbetrag']
hebesatz = d['totals']['hebesatz']
expected_kst = round(max(0, zve) * 0.15, 2)
expected_soli = round(expected_kst * 0.055, 2)
expected_messbetrag = round(max(0, zve // 100 * 100) * 0.035, 2)  # Tier 439: § 11 GewStG, rounded down to 100
expected_gewst = round(expected_messbetrag * hebesatz / 100, 2)
print(f'{abs(kst - expected_kst) < 0.01}|{abs(soli - expected_soli) < 0.01}|{abs(messbetrag - expected_messbetrag) < 0.01}|{abs(gewst - expected_gewst) < 0.01}|{kst}|{soli}|{messbetrag}|{gewst}|{expected_kst}|{expected_soli}|{expected_messbetrag}|{expected_gewst}')
" < "$TMP")
assert_eq "KSt identity" "$(echo "$MATH" | cut -d'|' -f1)" "True"
assert_eq "Soli identity" "$(echo "$MATH" | cut -d'|' -f2)" "True"
assert_eq "GewSt-Messbetrag identity" "$(echo "$MATH" | cut -d'|' -f3)" "True"
assert_eq "GewSt identity" "$(echo "$MATH" | cut -d'|' -f4)" "True"
pass "KSt=$(echo "$MATH" | cut -d'|' -f5) (expected $(echo "$MATH" | cut -d'|' -f9))"
rm -f "$TMP"

# ===== 5./6. Zu zahlen = KSt + Soli + GewSt =====
# Tier 439: there was a "KSt-Anrechnung" of min(KSt, 3.8 × Messbetrag) —
# § 35 EStG, an income-tax relief a GmbH does not get. Numbers: spec 228.
echo
note "=== 5. Zu zahlen = KSt + Soli + GewSt, no Anrechnung ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
ZZ=$(echo "$BODY" | python3 -c "
import json, sys
t = json.load(sys.stdin)['totals']
print(abs(t['zuZahlen'] - (t['kst'] + t['soli'] + t['gewst'])) < 0.01 and 'kstAnrechnung' not in t)
")
assert_eq "Zu zahlen identity, no Anrechnung field" "$ZZ" "True"

# ===== 7. /kst1.pdf returns valid PDF =====
echo
note "=== 7. /kst1.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/kst1-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/kst1.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/kst1-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/kst1-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/kst1-$TS.pdf

# ===== 8. Year validation =====
echo
note "=== 8. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 9. Cross-tenant =====
echo
note "=== 9. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 10. Berater packager includes KSt1 (GmbH) + EXCLUDES Anlage G =====
echo
note "=== 10. Berater packager: KSt1 included, Anlage G excluded (GmbH) ==="
# SH Leder GmbH is a GmbH → KSt 1 included,
# Anlage G excluded (mutually exclusive for
# Kapitalgesellschaften).
ZIP_PATH=/tmp/berater-kst-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-kst-$TS && cd /tmp/berater-kst-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

# KSt 1 present
KST1_FOUND=""
for n in 03 04 05 06; do
  if [[ -f "/tmp/berater-kst-$TS/${n}_KSt1.pdf" ]]; then
    KST1_FOUND="$n"
    break
  fi
done
[[ -n "$KST1_FOUND" ]] && pass "KSt1.pdf present at position $KST1_FOUND" || fail "KSt1.pdf not found in packager"

# KSt 1 PDF magic bytes
if [[ -n "$KST1_FOUND" ]]; then
  KST1_MAGIC=$(head -c 4 "/tmp/berater-kst-$TS/${KST1_FOUND}_KSt1.pdf" | xxd -p)
  assert_eq "KSt 1 PDF magic bytes" "$KST1_MAGIC" "25504446"
fi

# MANIFEST mentions KSt 1
MANIFEST_HAS_KST1=$(grep -c "KSt 1" /tmp/berater-kst-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_KST1" -ge 1 ]] && pass "MANIFEST mentions KSt 1 ($MANIFEST_HAS_KST1 lines)" || fail "MANIFEST missing KSt 1"

# Anlage G should be EXCLUDED (GmbH → KSt 1 instead)
G_PDF_ABSENT=$(find /tmp/berater-kst-$TS -name "*Anlage-G.pdf" 2>/dev/null | wc -l | tr -d ' \n')
G_PDF_ABSENT=${G_PDF_ABSENT:-0}
assert_eq "no Anlage-G.pdf (GmbH uses KSt 1 instead)" "$G_PDF_ABSENT" "0"

rm -rf /tmp/berater-kst-$TS "$ZIP_PATH"

# ===== 11. Disclaimer mentions § 1 KStG + Hebesatz hint =====
echo
note "=== 11. Disclaimer + 7-way shift correctness ==="
api_get "/api/v1/accounting/kst1?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

HAS_KSTG=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('§ 1 Abs. 1 KStG' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions § 1 KStG" "$HAS_KSTG" "True"

HAS_HEBESATZ=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('Hebesatz' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions Hebesatz" "$HAS_HEBESATZ" "True"
rm -f "$TMP"

summary
