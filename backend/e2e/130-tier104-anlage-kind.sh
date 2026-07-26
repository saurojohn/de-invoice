#!/usr/bin/env bash
# Tier 104 — Anlage Kind (Kinderfreibetrag +
# Kindergeld, § 32 / § 33 / § 33a EStG).
#
# Validates the new AnlageKindService + the
# /api/v1/accounting/anlage-kind endpoint + the
# /api/v1/accounting/anlage-kind.pdf endpoint +
# the /api/v1/accounting/anlage-kind/settings PUT
# endpoint + the Berater packager 9-way conditional
# shift (V + KAP + G + N + KSt 1 + R + Kind).
#
# v1: per-year array of children in
# Company.settings.kinder[year] = [{ name,
# birthDate, kindergeldEligible }, ...]. Standard
# rates (2024): Kindergeld 250 EUR/Kind (1-3),
# max 1.000 EUR for 4+; Kinderfreibetrag 7.932
# EUR/Kind (6.612 + 1.320).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /anlage-kind shape: 1 einnahmen + 4 ausgaben =====
echo
note "=== 1. /anlage-kind shape (1 einnahmen + 4 ausgaben) ==="
api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EI=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['einnahmen']))" < "$TMP")
AU=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['ausgaben']))" < "$TMP")
assert_eq "einnahmen count == 1" "$EI" "1"
assert_eq "ausgaben count == 4" "$AU" "4"
rm -f "$TMP"

# ===== 2. Key Kennziffern present =====
echo
note "=== 2. Key Kennziffern (6600, 6610, 6620, 6630, 6640) ==="
api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
for kz in 6600 6610 6620 6630 6640; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
all_lines = d['einnahmen'] + d['ausgaben']
print(any(l['kennziffer'] == '$kz' for l in all_lines))
" < "$TMP")
  assert_eq "Kennziffer $kz present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 3. Without Kinder, totals are 0 =====
echo
note "=== 3. Without Kinder: anzahlKinder == 0 + kindergeldTotal == 0 ==="
# Wipe any existing Kinder for 2026
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"kinder\": {\"2026\": []}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

ANZ=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['anzahlKinder'])" < "$TMP")
KG=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['kindergeldTotal'])" < "$TMP")
FB=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['freibetragTotal'])" < "$TMP")
assert_eq "anzahlKinder == 0" "$ANZ" "0"
assert_eq "kindergeldTotal == 0" "$KG" "0"
assert_eq "freibetragTotal == 0" "$FB" "0"
HAS_KINDER=$(python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['hasKinder'])" < "$TMP")
assert_eq "hasKinder == False" "$HAS_KINDER" "False"
rm -f "$TMP"

# ===== 4. PUT 2 Kinder + GET reflects values =====
echo
note "=== 4. PUT 2 Kinder + GET reflects values ==="
PUT_HEAD=$(curl -sS -X PUT -o /tmp/anlage-kind-put-$TS.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/anlage-kind/settings?companyId=$COMPANY_ID" \
  -d '{"year": 2026, "kinder": [{"name": "Max", "birthDate": "2018-05-12", "kindergeldEligible": true}, {"name": "Lisa", "birthDate": "2021-09-03", "kindergeldEligible": true}]}')
assert_eq "PUT 200" "$PUT_HEAD" "200"

api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

ANZ=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['anzahlKinder'])" < "$TMP")
assert_eq "anzahlKinder == 2" "$ANZ" "2"
NAMES=$(python3 -c "import json,sys; print(','.join(k['name'] for k in json.load(sys.stdin)['kinder']))" < "$TMP")
assert_eq "kinder names" "$NAMES" "Max,Lisa"
rm -f "$TMP"

# ===== 5. Math identities: Kindergeld 2*250=500, FB 2*7932=15864, net = 15364 =====
echo
note "=== 5. Math identities: standard rates (2024) ==="
api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

MATH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
kg = d['totals']['kindergeldTotal']
fb = d['totals']['freibetragTotal']
net = d['totals']['net']
expected_kg = 2 * 250
expected_fb = 2 * (6612 + 1320)
expected_net = expected_fb - expected_kg
print(f'{abs(kg - expected_kg) < 0.01}|{abs(fb - expected_fb) < 0.01}|{abs(net - expected_net) < 0.01}|{kg}|{fb}|{net}|{expected_kg}|{expected_fb}|{expected_net}')
" < "$TMP")
assert_eq "Kindergeld 2*250 == 500" "$(echo "$MATH" | cut -d'|' -f1)" "True"
assert_eq "Kinderfreibetrag 2*7932 == 15864" "$(echo "$MATH" | cut -d'|' -f2)" "True"
assert_eq "net = FB - KG" "$(echo "$MATH" | cut -d'|' -f3)" "True"
pass "KG=$(echo "$MATH" | cut -d'|' -f4), FB=$(echo "$MATH" | cut -d'|' -f5), net=$(echo "$MATH" | cut -d'|' -f6)"
rm -f "$TMP"

# ===== 6. Kz 6600/6610/6620 amounts scale per child =====
echo
note "=== 6. Kz 6600/6610/6620 amounts per child ==="
api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

K6600=$(python3 -c "import json,sys; print(next(l for l in json.load(sys.stdin)['einnahmen'] if l['kennziffer']=='6600')['amount'])" < "$TMP")
K6610=$(python3 -c "import json,sys; print(next(l for l in json.load(sys.stdin)['ausgaben'] if l['kennziffer']=='6610')['amount'])" < "$TMP")
K6620=$(python3 -c "import json,sys; print(next(l for l in json.load(sys.stdin)['ausgaben'] if l['kennziffer']=='6620')['amount'])" < "$TMP")
assert_eq "Kz 6600 == 2*250 = 500" "$K6600" "500"
assert_eq "Kz 6610 == 2*6612 = 13224" "$K6610" "13224"
assert_eq "Kz 6620 == 2*1320 = 2640" "$K6620" "2640"
rm -f "$TMP"

# ===== 7. /anlage-kind.pdf returns valid PDF =====
echo
note "=== 7. /anlage-kind.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-kind-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kind.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/anlage-kind-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/anlage-kind-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/anlage-kind-$TS.pdf

# ===== 8. Year validation =====
echo
note "=== 8. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 9. Cross-tenant =====
echo
note "=== 9. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 10. Berater packager includes 09_Anlage-Kind when Kinder present =====
echo
note "=== 10. Berater packager includes Anlage Kind (auto-include on Kinder) ==="
ZIP_PATH=/tmp/berater-kind-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-kind-$TS && cd /tmp/berater-kind-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

MANIFEST_HAS_KIND=$(grep -c "Anlage Kind" /tmp/berater-kind-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_KIND" -ge 1 ]] && pass "MANIFEST mentions Anlage Kind ($MANIFEST_HAS_KIND lines)" || fail "MANIFEST missing Anlage Kind"

# Anlage Kind PDF present (could be 05-09 depending on V/KAP/G/N/KSt1/R)
KIND_PDF_FOUND=""
for n in 04 05 06 07 08 09 10; do
  if [[ -f "/tmp/berater-kind-$TS/${n}_Anlage-Kind.pdf" ]]; then
    KIND_PDF_FOUND="$n"
    break
  fi
done
[[ -n "$KIND_PDF_FOUND" ]] && pass "Anlage-Kind.pdf present at position $KIND_PDF_FOUND" || fail "Anlage-Kind.pdf not found in packager"

# Anlage Kind PDF is a real PDF
if [[ -n "$KIND_PDF_FOUND" ]]; then
  KIND_MAGIC=$(head -c 4 "/tmp/berater-kind-$TS/${KIND_PDF_FOUND}_Anlage-Kind.pdf" | xxd -p)
  assert_eq "Anlage Kind PDF magic bytes" "$KIND_MAGIC" "25504446"
fi

rm -rf /tmp/berater-kind-$TS "$ZIP_PATH"

# ===== 11. Berater packager EXCLUDES Anlage Kind when opt-out + no Kinder =====
echo
note "=== 11. Berater packager EXCLUDES Anlage Kind when opt-out + no Kinder ==="
# Force opt-out + no Kinder for 2024
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"anlageKind\": false, \"kinder\": {}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

ZIP_PATH=/tmp/berater-no-kind-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2024"

mkdir -p /tmp/berater-no-kind-$TS && cd /tmp/berater-no-kind-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

KIND_PDF_ABSENT=$(find /tmp/berater-no-kind-$TS -name "*Anlage-Kind.pdf" 2>/dev/null | wc -l | tr -d ' \n')
KIND_PDF_ABSENT=${KIND_PDF_ABSENT:-0}
assert_eq "no Anlage-Kind.pdf in packager (opt-out, no data)" "$KIND_PDF_ABSENT" "0"

MANIFEST_KIND_ROW=$(grep -c "| \`[0-9][0-9]_Anlage-Kind.pdf\`" /tmp/berater-no-kind-$TS/MANIFEST.md 2>/dev/null || true)
MANIFEST_KIND_ROW=$(echo "$MANIFEST_KIND_ROW" | tr -d ' \n')
MANIFEST_KIND_ROW=${MANIFEST_KIND_ROW:-0}
assert_eq "no Anlage Kind row in MANIFEST (opt-out)" "$MANIFEST_KIND_ROW" "0"

rm -rf /tmp/berater-no-kind-$TS "$ZIP_PATH"

# Cleanup: remove the test Kinder + anlageKind settings
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'anlageKind' - 'kinder'
  WHERE id = '$COMPANY_ID';" >/dev/null

# ===== 12. counts + disclaimer =====
echo
note "=== 12. counts + disclaimer present ==="
api_get "/api/v1/accounting/anlage-kind?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{isinstance(c[\"hasKinder\"], bool)}')
" < "$TMP")
assert_eq "hasKinder is bool" "$HAS_COUNTS" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

# Disclaimer mentions Kinderfreibetrag + Kindergeld
HAS_FB=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('Kinderfreibetrag' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions Kinderfreibetrag" "$HAS_FB" "True"

HAS_KG=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('Kindergeld' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions Kindergeld" "$HAS_KG" "True"

HAS_BEAF=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('BEAfA' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions BEAfA" "$HAS_BEAF" "True"
rm -f "$TMP"

# ===== 13. PATCH /feature-flags with anlageKind = true persists =====
echo
note "=== 13. PATCH /feature-flags with anlageKind ==="
PATCH_HEAD=$(curl -sS -X PATCH -o /tmp/ff-kind-$TS.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -d '{"anlageKind": true}')
assert_eq "PATCH anlageKind=true → 200" "$PATCH_HEAD" "200"

GET_FF=$(curl -sS \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
FF_KIND=$(echo "$GET_FF" | python3 -c "import json,sys; print(str(json.load(sys.stdin)['anlageKind']).lower())")
assert_eq "GET anlageKind == true" "$FF_KIND" "true"

# Cleanup
curl -sS -X PATCH \
  "$API/api/v1/companies/$COMPANY_ID/feature-flags" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"anlageKind": false}' >/dev/null

summary
