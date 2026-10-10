#!/usr/bin/env bash
# Tier 103 — Anlage R (Einkünfte aus Renten und
# Bezügen, § 22 EStG).
#
# Validates the new AnlageRService + the
# /api/v1/accounting/anlage-r endpoint + the
# /api/v1/accounting/anlage-r.pdf endpoint +
# the /api/v1/accounting/anlage-r/settings PUT
# endpoint + the Berater packager 8-way
# conditional shift (V + KAP + G + N + KSt 1 + R).
#
# v1: Besteuerungsanteil from BMF table per year
# (2026: 81%, decreasing to 50% in 2057). Werbungs-
# kosten-Pauschbetrag 102 EUR auto (Kz 210).
# Ertragsanteil for private Rente simplified to
# 50% (v2: full BMF table by age).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /anlage-r shape: 6 einnahmen + 4 werbungskosten =====
echo
note "=== 1. /anlage-r shape (6 einnahmen + 4 werbungskosten) ==="
api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EI=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['einnahmen']))" < "$TMP")
WK=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['werbungskosten']))" < "$TMP")
assert_eq "einnahmen count == 6" "$EI" "6"
assert_eq "werbungskosten count == 4" "$WK" "4"

# ===== 2. Key Kennziffern present =====
echo
note "=== 2. Key Kennziffern (100, 110, 140, 210) ==="
for kz in 100 110 120 130 140 150 200 210 220 230; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
all_lines = d['einnahmen'] + d['werbungskosten']
print(any(l['kennziffer'] == '$kz' for l in all_lines))
" < "$TMP")
  assert_eq "Kennziffer $kz present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 3. Without Rentenbezüge, einkuenfte = -102 (Pauschbetrag only) =====
echo
note "=== 3. Without Rentenbezüge: einkuenfte == -102 (Pauschbetrag) ==="
# Wipe any existing Rentenbezüge + Werbungs-
# kosten for 2026
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"renten\": {\"2026\": {}}, \"rentenWerbungskosten\": {\"2026\": {}}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EK=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['einkuenfte'])" < "$TMP")
assert_eq "einkuenfte == -102 (no Rentenbezüge, only Pauschbetrag)" "$EK" "-102"
rm -f "$TMP"

# ===== 4. Besteuerungsanteil =====
# Tier 655: it follows the year the pension BEGAN (§ 22 Nr. 1 S. 3 a) aa)
# EStG: 50 % to 2005, 80 % for 2020, 82,5 % for 2023, 84 % for 2026, 100 %
# from 2058) — not the tax year, by a table that fell again after 2024 (81 %
# "for 2026", 50 % "in 2057"). Nothing entered: the share of a pension that
# begins in the tax year, the highest there can be.
echo
note "=== 4. no start entered: the share of a pension beginning in 2026, 84 % ==="
api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

BA=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['besteuerungsanteil'])" < "$TMP")
assert_eq "besteuerungsanteil == 84 (a pension beginning in 2026; was 81)" "$BA" "84"
rm -f "$TMP"

# ===== 5. PUT Rentenbezüge + GET reflects values =====
echo
note "=== 5. PUT Rentenbezüge + GET reflects values ==="
PUT_HEAD=$(curl -sS -X PUT -o /tmp/anlage-r-put-$TS.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/anlage-r/settings?companyId=$COMPANY_ID" \
  -d '{"year": 2026, "drv": 18000, "bav": 6000, "riester": 1200, "ruerup": 0, "privat": 2400, "sonstige": 0, "drvBeginn": 2010, "privatAlter": 65, "werbungskosten": {"200": 0, "220": 0, "230": 150}}')
assert_eq "PUT 200" "$PUT_HEAD" "200"

api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

DRV=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rentenbezuege']['drv'])" < "$TMP")
assert_eq "drv == 18000" "$DRV" "18000"
PRIVAT=$(python3 -c "import json,sys; print(json.load(sys.stdin)['rentenbezuege']['privat'])" < "$TMP")
assert_eq "privat == 2400" "$PRIVAT" "2400"
WK230=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l for l in d['werbungskosten'] if l['kennziffer']=='230')['amount'])" < "$TMP")
assert_eq "Kz 230 (sonstige WK) == 150" "$WK230" "150"

# ===== 6. Math identities: DRV × 81% = 14580, privat × 50% = 1200 =====
echo
note "=== 6. Math identities: Besteuerungsanteil + Ertragsanteil ==="
MATH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
drv_anteil = next(l for l in d['einnahmen'] if l['kennziffer'] == '100')['amount']
privat_anteil = next(l for l in d['einnahmen'] if l['kennziffer'] == '140')['amount']
einnahmen_total = d['totals']['einnahmenTotal']
# Tier 655: the statutory pension began in 2010 → 60 %; the private annuity at
# 65 → Ertragsanteil 18 % (was a flat 50 %); the company pension and the
# Riester pension in full, § 22 Nr. 5 (were 81 % too)
expected_drv = round(18000 * 0.60, 2)
expected_privat = round(2400 * 0.18, 2)
expected_einnahmen = expected_drv + 6000 + 1200 + expected_privat
print(f'{abs(drv_anteil - expected_drv) < 0.01}|{abs(privat_anteil - expected_privat) < 0.01}|{abs(einnahmen_total - expected_einnahmen) < 0.01}|{drv_anteil}|{privat_anteil}|{einnahmen_total}|{expected_drv}|{expected_privat}|{expected_einnahmen}')
" < "$TMP")
assert_eq "DRV × 60 % (begun 2010) == 10800 (was × 81 % = 14580)" "$(echo "$MATH" | cut -d'|' -f1)" "True"
assert_eq "privat × 18 % (begun at 65) == 432 (was × 50 % = 1200)" "$(echo "$MATH" | cut -d'|' -f2)" "True"
assert_eq "Einnahmen total = 10800 + 6000 + 1200 + 432" "$(echo "$MATH" | cut -d"|" -f6)" "18432"
rm -f "$TMP"

# Tier 655: the table, by start year and by age
share() { # body-fields → "aa-share|bb-share"
  curl -sS -o /dev/null -X PUT -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json" \
    "$API/api/v1/accounting/anlage-r/settings?companyId=$COMPANY_ID" -d '{"year": 2026, "drv": 1000, "privat": 1000, '"$1"'}'
  api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
  python3 -c "import json,sys; t=json.load(sys.stdin)['totals']; print('%s|%s' % (t['besteuerungsanteil'], t['ertragsanteil']))" <<< "$BODY"
}
assert_eq "begun 1998, at 60: 50 % and 22 %" "$(share '"drvBeginn": 1998, "privatAlter": 60')" "50|22"
assert_eq "begun 2020, at 63: 80 % and 20 %" "$(share '"drvBeginn": 2020, "privatAlter": 63')" "80|20"
assert_eq "begun 2022, at 67: 82 % and 17 %" "$(share '"drvBeginn": 2022, "privatAlter": 67')" "82|17"
assert_eq "begun 2023, at 70: 82.5 % and 15 %" "$(share '"drvBeginn": 2023, "privatAlter": 70')" "82.5|15"
assert_eq "begun 2025, at 97: 83.5 % and 1 %" "$(share '"drvBeginn": 2025, "privatAlter": 97')" "83.5|1"
assert_eq "not known (null): 84 % and the highest Ertragsanteil, 59 %" "$(share '"drvBeginn": null, "privatAlter": null')" "84|59"
api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
echo "$BODY" | grep -q "Rentenbeginn nicht eingetragen" && pass "… and the line says that the start is missing" || fail "no note about the missing start"
for bad in '"drvBeginn": 2030' '"drvBeginn": "früher"' '"privatAlter": 130' '"privatAlter": 64.5'; do
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json" \
    "$API/api/v1/accounting/anlage-r/settings?companyId=$COMPANY_ID" -d '{"year": 2026, "drv": 1000, '"$bad"'}')
  assert_eq "refused: $bad" "$CODE" "400"
done

# ===== 7. Einkünfte = Einnahmen - Werbungskosten =====
echo
note "=== 7. Einkünfte = Einnahmen - Werbungskosten ==="
api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
e = d['totals']['einnahmenTotal']
wk = d['totals']['werbungskostenTotal']
ek = d['totals']['einkuenfte']
expected = e - wk
print(f'{abs(ek - expected) < 0.01}|{ek}|{expected}|{e}|{wk}')
" < "$TMP")
assert_eq "Einkünfte identity" "$(echo "$EK" | cut -d'|' -f1)" "True"
pass "Einkünfte=$(echo "$EK" | cut -d'|' -f2) (expected $(echo "$EK" | cut -d'|' -f3))"
rm -f "$TMP"

# ===== 8. /anlage-r.pdf returns valid PDF =====
echo
note "=== 8. /anlage-r.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-r-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-r.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/anlage-r-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/anlage-r-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/anlage-r-$TS.pdf

# ===== 9. Year validation =====
echo
note "=== 9. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 10. Cross-tenant =====
echo
note "=== 10. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 11. Berater packager includes 04_Anlage-R when Rentenbezüge present =====
echo
note "=== 11. Berater packager includes Anlage R (auto-include on Rentenbezüge) ==="
ZIP_PATH=/tmp/berater-r-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-r-$TS && cd /tmp/berater-r-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

MANIFEST_HAS_R=$(grep -c "Anlage R" /tmp/berater-r-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_R" -ge 1 ]] && pass "MANIFEST mentions Anlage R ($MANIFEST_HAS_R lines)" || fail "MANIFEST missing Anlage R"

# Anlage R PDF present (could be 04-07 depending on V/KAP/G/N/KSt1)
R_PDF_FOUND=""
for n in 03 04 05 06 07; do
  if [[ -f "/tmp/berater-r-$TS/${n}_Anlage-R.pdf" ]]; then
    R_PDF_FOUND="$n"
    break
  fi
done
[[ -n "$R_PDF_FOUND" ]] && pass "Anlage-R.pdf present at position $R_PDF_FOUND" || fail "Anlage-R.pdf not found in packager"

# Anlage R PDF is a real PDF
if [[ -n "$R_PDF_FOUND" ]]; then
  R_MAGIC=$(head -c 4 "/tmp/berater-r-$TS/${R_PDF_FOUND}_Anlage-R.pdf" | xxd -p)
  assert_eq "Anlage R PDF magic bytes" "$R_MAGIC" "25504446"
fi

rm -rf /tmp/berater-r-$TS "$ZIP_PATH"

# ===== 12. Berater packager EXCLUDES Anlage R when opt-out + no Renten =====
echo
note "=== 12. Berater packager EXCLUDES Anlage R when opt-out + no Renten ==="
# Force opt-out: clear any anlageR setting
# AND check a year with no Rentenbezüge (2024)
# has 0 Renten. The PDF should not be
# included and the MANIFEST should not
# mention Anlage R.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"anlageR\": false, \"renten\": {}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

ZIP_PATH=/tmp/berater-no-r-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2024"

mkdir -p /tmp/berater-no-r-$TS && cd /tmp/berater-no-r-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

R_PDF_ABSENT=$(find /tmp/berater-no-r-$TS -name "*Anlage-R.pdf" 2>/dev/null | wc -l | tr -d ' \n')
R_PDF_ABSENT=${R_PDF_ABSENT:-0}
assert_eq "no Anlage-R.pdf in packager (opt-out, no data)" "$R_PDF_ABSENT" "0"

MANIFEST_R_ROW=$(grep -c "| \`[0-9][0-9]_Anlage-R.pdf\`" /tmp/berater-no-r-$TS/MANIFEST.md 2>/dev/null || true)
MANIFEST_R_ROW=$(echo "$MANIFEST_R_ROW" | tr -d ' \n')
MANIFEST_R_ROW=${MANIFEST_R_ROW:-0}
assert_eq "no Anlage R row in MANIFEST (opt-out)" "$MANIFEST_R_ROW" "0"

rm -rf /tmp/berater-no-r-$TS "$ZIP_PATH"

# Cleanup: remove the test Renten settings
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'anlageR' - 'renten' - 'rentenWerbungskosten'
  WHERE id = '$COMPANY_ID';" >/dev/null

# ===== 13. counts + disclaimer =====
echo
note "=== 13. counts + disclaimer present ==="
api_get "/api/v1/accounting/anlage-r?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{isinstance(c[\"hasRentenbezuege\"], bool)}')
" < "$TMP")
assert_eq "hasRentenbezuege is bool" "$HAS_COUNTS" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

# Disclaimer mentions § 22 EStG + BMF table
HAS_22=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('§ 22 EStG' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions § 22 EStG" "$HAS_22" "True"

HAS_BMF=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('BMF' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions BMF" "$HAS_BMF" "True"
rm -f "$TMP"

summary
