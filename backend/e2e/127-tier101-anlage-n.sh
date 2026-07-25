#!/usr/bin/env bash
# Tier 101 — Anlage N (Arbeitnehmereinkünfte,
# § 3 EStG).
#
# Validates the new AnlageNService + the
# /api/v1/accounting/anlage-n endpoint + the
# /api/v1/accounting/anlage-n.pdf endpoint +
# the /api/v1/accounting/anlage-n/settings PUT
# endpoint + the Berater packager 6-way
# conditional shift (V + KAP + G + N).
#
# v1: Lohnsteuerbescheinigung is stored on
# Company.settings.lohnsteuerbescheinigungen
# (a per-year map). The user enters the values
# via the section's manual input. The Werbungs-
# kosten use the standard Pauschbetrag (1.230
# EUR) by default + manual entries per Kz.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /anlage-n shape: 1 einnahmen + 7 werbungskosten + 3 sonderausgaben + 4 aB =====
echo
note "=== 1. /anlage-n shape (1 + 7 + 3 + 4) ==="
api_get "/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EI=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['einnahmen']))" < "$TMP")
WK=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['werbungskosten']))" < "$TMP")
SA=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['sonderausgaben']))" < "$TMP")
AB=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['aussergewoehnlicheBelastungen']))" < "$TMP")
assert_eq "einnahmen count == 1" "$EI" "1"
assert_eq "werbungskosten count == 7" "$WK" "7"
assert_eq "sonderausgaben count == 3" "$SA" "3"
assert_eq "aussergewoehnlicheBelastungen count == 4" "$AB" "4"

# ===== 2. Key Kennziffern present =====
echo
note "=== 2. Key Kennziffern (100, 130, 200, 230) ==="
for kz in 100 130 140 150 160 170 180 190 200 210 220 230 240 250 260; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
all_lines = (
  d['einnahmen']
  + d['werbungskosten']
  + d['sonderausgaben']
  + d['aussergewoehnlicheBelastungen']
)
print(any(l['kennziffer'] == '$kz' for l in all_lines))
" < "$TMP")
  assert_eq "Kennziffer $kz present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 3. Without Lohnsteuerbescheinigung, einkuenfte = -1230 (only Pauschbetrag) =====
echo
note "=== 3. Without LSB: einkuenfte == -1230 (Pauschbetrag) ==="
# Wipe any existing Lohnsteuerbescheinigung
# + Werbungskosten for 2026 (cleanup leftover
# from manual tests)
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"lohnsteuerbescheinigungen\": {\"2026\": {}}, \"werbungskosten\": {\"2026\": {}}, \"sonderausgaben\": {\"2026\": {}}, \"aussergewoehnlicheBelastungen\": {\"2026\": {}}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

api_get "/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EK=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['einkuenfte'])" < "$TMP")
assert_eq "einkuenfte == -1230 (no LSB, only Pauschbetrag)" "$EK" "-1230"
rm -f "$TMP"

# ===== 4. PUT Lohnsteuerbescheinigung + GET reflects new values =====
echo
note "=== 4. PUT Lohnsteuerbescheinigung + GET reflects values ==="
PUT_HEAD=$(curl -sS -X PUT -o /tmp/anlage-n-put-$TS.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/anlage-n/settings?companyId=$COMPANY_ID" \
  -d '{"year": 2026, "bruttoArbeitslohn": 60000, "lohnsteuer": 10000, "soli": 550, "kirchensteuer": 900, "rentenversicherung": 5616, "arbeitslosenversicherung": 720, "krankenversicherung": 4350, "pflegeversicherung": 1100, "werbungskosten": {"140": 1500, "170": 800}}')
assert_eq "PUT 200" "$PUT_HEAD" "200"

api_get "/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# Verify brutto + werbungskosten persisted
BRUTTO=$(python3 -c "import json,sys; print(json.load(sys.stdin)['lohnsteuerbescheinigung']['bruttoArbeitslohn'])" < "$TMP")
assert_eq "bruttoArbeitslohn == 60000" "$BRUTTO" "60000"
WK140=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l for l in d['werbungskosten'] if l['kennziffer']=='140')['amount'])" < "$TMP")
assert_eq "Kz 140 (Entfernungspauschale) == 1500" "$WK140" "1500"
WK170=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(next(l for l in d['werbungskosten'] if l['kennziffer']=='170')['amount'])" < "$TMP")
assert_eq "Kz 170 (Fortbildung) == 800" "$WK170" "800"

# ===== 5. Math identity: einkuenfte = brutto - werbungskosten - 0 (no SA / aB) =====
echo
note "=== 5. Math identity: einkuenfte = brutto - werbungskosten ==="
EK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
brutto = d['totals']['bruttoArbeitslohn']
wk = d['totals']['werbungskostenTotal']
ek = d['totals']['einkuenfte']
expected = brutto - wk  # 60000 - (1230 + 1500 + 800) = 56470
print(f'{abs(ek - expected) < 0.01}|{brutto}|{wk}|{ek}|{expected}')
" < "$TMP")
assert_eq "einkuenfte identity" "$(echo "$EK" | cut -d'|' -f1)" "True"
pass "einkuenfte=$(echo "$EK" | cut -d'|' -f4) (expected $(echo "$EK" | cut -d'|' -f5))"
rm -f "$TMP"

# ===== 6. Lohnsteuer total = Lohnsteuer + Soli + KiSt =====
echo
note "=== 6. Lohnsteuer total = Lohnsteuer + Soli + KiSt ==="
api_get "/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

LT=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
lsb = d['lohnsteuerbescheinigung']
expected = lsb['lohnsteuer'] + lsb['soli'] + lsb['kirchensteuer']
total = d['totals']['lohnsteuerTotal']
print(f'{abs(total - expected) < 0.01}|{total}|{expected}|{lsb[\"lohnsteuer\"]}|{lsb[\"soli\"]}|{lsb[\"kirchensteuer\"]}')
" < "$TMP")
assert_eq "lohnsteuerTotal identity" "$(echo "$LT" | cut -d'|' -f1)" "True"
pass "lohnsteuerTotal=$(echo "$LT" | cut -d'|' -f2) (expected $(echo "$LT" | cut -d'|' -f3))"
rm -f "$TMP"

# ===== 7. /anlage-n.pdf returns valid PDF =====
echo
note "=== 7. /anlage-n.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-n-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-n.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/anlage-n-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/anlage-n-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/anlage-n-$TS.pdf

# ===== 8. Year validation =====
echo
note "=== 8. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 9. Cross-tenant =====
echo
note "=== 9. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 10. Berater packager includes 05_Anlage-N when LSB present =====
echo
note "=== 10. Berater packager includes Anlage N (auto-include on LSB) ==="
ZIP_PATH=/tmp/berater-n-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-n-$TS && cd /tmp/berater-n-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

MANIFEST_HAS_N=$(grep -c "Anlage N" /tmp/berater-n-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_N" -ge 1 ]] && pass "MANIFEST mentions Anlage N ($MANIFEST_HAS_N lines)" || fail "MANIFEST missing Anlage N"

# Anlage N PDF present (could be 04-06 depending on V/KAP/G)
N_PDF_FOUND=""
for n in 03 04 05 06; do
  if [[ -f "/tmp/berater-n-$TS/${n}_Anlage-N.pdf" ]]; then
    N_PDF_FOUND="$n"
    break
  fi
done
[[ -n "$N_PDF_FOUND" ]] && pass "Anlage-N.pdf present at position $N_PDF_FOUND" || fail "Anlage-N.pdf not found in packager"

# Anlage N PDF is a real PDF
if [[ -n "$N_PDF_FOUND" ]]; then
  N_MAGIC=$(head -c 4 "/tmp/berater-n-$TS/${N_PDF_FOUND}_Anlage-N.pdf" | xxd -p)
  assert_eq "Anlage N PDF magic bytes" "$N_MAGIC" "25504446"
fi

rm -rf /tmp/berater-n-$TS "$ZIP_PATH"

# ===== 11. Berater packager EXCLUDES Anlage N when opt-out + no LSB =====
echo
note "=== 11. Berater packager EXCLUDES Anlage N when opt-out + no LSB ==="
# Clear LSB for 2024 (a year with no LSB
# + no other income) + force anlageN=false
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"anlageN\": false, \"lohnsteuerbescheinigungen\": {}}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

ZIP_PATH=/tmp/berater-no-n-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2024"

mkdir -p /tmp/berater-no-n-$TS && cd /tmp/berater-no-n-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

N_PDF_ABSENT=$(find /tmp/berater-no-n-$TS -name "*Anlage-N.pdf" 2>/dev/null | wc -l | tr -d ' \n')
N_PDF_ABSENT=${N_PDF_ABSENT:-0}
assert_eq "no Anlage-N.pdf in packager (opt-out, no LSB)" "$N_PDF_ABSENT" "0"

MANIFEST_N_ABSENT=$(grep -c "Anlage N" /tmp/berater-no-n-$TS/MANIFEST.md 2>/dev/null || true)
MANIFEST_N_ABSENT=$(echo "$MANIFEST_N_ABSENT" | tr -d ' \n')
MANIFEST_N_ABSENT=${MANIFEST_N_ABSENT:-0}
assert_eq "no Anlage N in MANIFEST (opt-out)" "$MANIFEST_N_ABSENT" "0"

rm -rf /tmp/berater-no-n-$TS "$ZIP_PATH"

# Cleanup: remove the test LSB settings
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'anlageN' - 'lohnsteuerbescheinigungen'
  WHERE id = '$COMPANY_ID';" >/dev/null

# ===== 12. counts + disclaimer =====
echo
note "=== 12. counts + disclaimer present ==="
api_get "/api/v1/accounting/anlage-n?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{isinstance(c[\"hasLohnsteuerbescheinigung\"], bool)}')
" < "$TMP")
assert_eq "hasLohnsteuerbescheinigung is bool" "$HAS_COUNTS" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

# Disclaimer mentions § 3 EStG (Arbeitnehmereinkünfte)
HAS_3=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('§ 3 EStG' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions § 3 EStG" "$HAS_3" "True"
rm -f "$TMP"

summary
