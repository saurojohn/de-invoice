#!/usr/bin/env bash
# Tier 106 — GewSt-Erklärung (Gewerbesteuererklärung,
# BMF Vordruck GewSt 1A 2024).
#
# Validates the new GewstService + the
# /api/v1/accounting/gewst endpoint + the
# /api/v1/accounting/gewst.pdf endpoint + the
# /api/v1/accounting/gewst/settings PUT endpoint +
# the Berater packager 11-way shift (V + KAP + G +
# N + KSt 1 + R + Kind + UStJA + GewSt + 4 HGB).
#
# v1: reuses AnlageGService for the underlying
# gewerbeertrag + hebesatz + freibetrag. Adds the
# BMF Vordruck Kz 5 (Steuermessbetrag) + Kz 7
# (Hebesatz) + Kz 10 (festzusetzende GewSt) + Kz 11
# (Vorauszahlungen, manuell) + Kz 12 (Differenz).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /gewst shape: Kz 5/7/10/11/12 + 4 Vorauszahlungen =====
echo
note "=== 1. /gewst shape (Kz 5/7/10/11/12) ==="
api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# Key Kennziffern present
for kz in 5 7 10 11 12; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
print(any(l['kennziffer'] == '$kz' for l in d['lines']))
" < "$TMP")
  assert_eq "Kennziffer $kz present" "$HAS" "True"
done

# Vorauszahlungen structure
VQ=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
vq = d['vorauszahlungen']
ok = all(k in vq for k in ('q1','q2','q3','q4','total'))
print(ok)
" < "$TMP")
assert_eq "vorauszahlungen has q1-q4 + total" "$VQ" "True"
rm -f "$TMP"

# ===== 2. Math identity: Kz 5 = gewerbeertragNachFreibetrag × 0.035 =====
echo
note "=== 2. Math identity: Kz 5 = Kz 7% × gewerbeertragNachFreibetrag ==="
api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

MATH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
ge = d['gewerbeertragNachFreibetrag']
kz5 = next(l for l in d['lines'] if l['kennziffer'] == '5')['amount']
kz7 = next(l for l in d['lines'] if l['kennziffer'] == '7')['percent']
kz10 = next(l for l in d['lines'] if l['kennziffer'] == '10')['amount']
kz11 = next(l for l in d['lines'] if l['kennziffer'] == '11')['amount']
kz12 = next(l for l in d['lines'] if l['kennziffer'] == '12')['amount']
expected5 = round(ge * 0.035, 2)
expected10 = round(kz5 * kz7 / 100, 2)
expected12 = round(kz10 - kz11, 2)
print(f'{abs(kz5 - expected5) < 0.01}|{abs(kz10 - expected10) < 0.01}|{abs(kz12 - expected12) < 0.01}|{kz5}|{kz7}|{kz10}|{kz11}|{kz12}|{ge}')
" < "$TMP")
assert_eq "Kz 5 = 3.5% × gewerbeertragNachFreibetrag" "$(echo "$MATH" | cut -d'|' -f1)" "True"
assert_eq "Kz 10 = Kz 5 × Kz 7 / 100" "$(echo "$MATH" | cut -d'|' -f2)" "True"
assert_eq "Kz 12 = Kz 10 - Kz 11" "$(echo "$MATH" | cut -d'|' -f3)" "True"
pass "Kz 5=$(echo "$MATH" | cut -d'|' -f4), Kz 7=$(echo "$MATH" | cut -d'|' -f5)%, Kz 10=$(echo "$MATH" | cut -d'|' -f6), Kz 11=$(echo "$MATH" | cut -d'|' -f7), Kz 12=$(echo "$MATH" | cut -d'|' -f8), GE_nach_FB=$(echo "$MATH" | cut -d'|' -f9)"
rm -f "$TMP"

# ===== 3. totals object matches Kz lines =====
echo
note "=== 3. totals object matches Kz lines ==="
api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

TOTALS_MATCH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
t = d['totals']
l = d['lines']
kz5 = next(x for x in l if x['kennziffer'] == '5')['amount']
kz7 = next(x for x in l if x['kennziffer'] == '7')['percent']
kz10 = next(x for x in l if x['kennziffer'] == '10')['amount']
kz11 = next(x for x in l if x['kennziffer'] == '11')['amount']
kz12 = next(x for x in l if x['kennziffer'] == '12')['amount']
matches = (
  abs(t['steuermessbetrag'] - kz5) < 0.01
  and t['hebesatz'] == kz7
  and abs(t['festzusetzendeGewerbesteuer'] - kz10) < 0.01
  and abs(t['vorauszahlungenTotal'] - kz11) < 0.01
  and abs(t['differenz'] - kz12) < 0.01
)
print('True' if matches else 'False')
" < "$TMP")
assert_eq "totals object matches Kz lines" "$TOTALS_MATCH" "True"
rm -f "$TMP"

# ===== 4. PUT Vorauszahlungen + GET reflects values =====
echo
note "=== 4. PUT 4 Vorauszahlungen + GET reflects values ==="
PUT_HEAD=$(curl -sS -X PUT -o /tmp/gewst-put-$TS.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/gewst/settings?companyId=$COMPANY_ID" \
  -d '{"year": 2026, "q1": 1500, "q2": 1500, "q3": 1500, "q4": 1500}')
assert_eq "PUT 200" "$PUT_HEAD" "200"

api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

VQ_TOTAL=$(python3 -c "import json,sys; print(json.load(sys.stdin)['vorauszahlungen']['total'])" < "$TMP")
assert_eq "Vorauszahlungen total == 6000" "$VQ_TOTAL" "6000"

HAS_VQ=$(python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['hasVorauszahlungen'])" < "$TMP")
assert_eq "hasVorauszahlungen == True" "$HAS_VQ" "True"

# Kz 12 should now reflect -6000 (negative = Erstattung)
KZ12=$(python3 -c "import json,sys; print(next(l for l in json.load(sys.stdin)['lines'] if l['kennziffer'] == '12')['amount'])" < "$TMP")
assert_eq "Kz 12 = Kz 10 - 6000" "$KZ12" "-6000"
rm -f "$TMP"

# ===== 5. Kz 7 (Hebesatz) comes from settings OR default 400 =====
echo
note "=== 5. Kz 7 (Hebesatz) default 400 OR from settings ==="
api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HZ=$(python3 -c "import json,sys; print(json.load(sys.stdin)['totals']['hebesatz'])" < "$TMP")
# SH Leder GmbH doesn't have hebesatz override → 400
test "$HZ" -ge 100 && test "$HZ" -le 999 && pass "Hebesatz = $HZ %" || fail "Hebesatz out of range: $HZ"
rm -f "$TMP"

# ===== 6. /gewst.pdf returns valid PDF =====
echo
note "=== 6. /gewst.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/gewst-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/gewst.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/gewst-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/gewst-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/gewst-$TS.pdf

# ===== 7. Year validation =====
echo
note "=== 7. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 8. Cross-tenant =====
echo
note "=== 8. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 9. PUT validation: invalid year =====
echo
note "=== 9. PUT /settings validation: invalid year ==="
STATUS_YEAR=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/gewst/settings?companyId=$COMPANY_ID" \
  -d '{"year": 1999, "q1": 0, "q2": 0, "q3": 0, "q4": 0}')
assert_eq "PUT year=1999 → 400" "$STATUS_YEAR" "400"

# ===== 10. PUT empty body / missing year =====
echo
note "=== 10. PUT /settings missing year → 400 ==="
STATUS_NO_YEAR=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  "$API/api/v1/accounting/gewst/settings?companyId=$COMPANY_ID" \
  -d '{"q1": 0, "q2": 0, "q3": 0, "q4": 0}')
assert_eq "PUT missing year → 400" "$STATUS_NO_YEAR" "400"

# ===== 11. Berater packager ALWAYS includes GewSt =====
echo
note "=== 11. Berater packager ALWAYS includes GewSt ==="
ZIP_PATH=/tmp/berater-gewst-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-gewst-$TS && cd /tmp/berater-gewst-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

GEWST_PDF=$(find /tmp/berater-gewst-$TS -name "*GewSt.pdf" | head -1)
[[ -n "$GEWST_PDF" ]] && pass "GewSt.pdf present in packager" || fail "GewSt.pdf missing from packager"
if [[ -n "$GEWST_PDF" ]]; then
  GEWST_MAGIC=$(head -c 4 "$GEWST_PDF" | xxd -p)
  assert_eq "GewSt PDF magic bytes" "$GEWST_MAGIC" "25504446"
fi

MANIFEST_HAS_GEWST=$(grep -c "GewSt" /tmp/berater-gewst-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_GEWST" -ge 1 ]] && pass "MANIFEST mentions GewSt ($MANIFEST_HAS_GEWST lines)" || fail "MANIFEST missing GewSt"

rm -rf /tmp/berater-gewst-$TS "$ZIP_PATH"

# ===== 12. counts + disclaimer =====
echo
note "=== 12. counts + disclaimer present ==="
api_get "/api/v1/accounting/gewst?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{isinstance(c[\"hasGewerbeertrag\"], bool) and isinstance(c[\"hasVorauszahlungen\"], bool)}')
" < "$TMP")
assert_eq "counts object present + types correct" "$HAS_COUNTS" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"

# Disclaimer mentions GewStG + BMF
HAS_GEWSTG=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('GewStG' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions GewStG" "$HAS_GEWSTG" "True"

HAS_BMF=$(python3 -c "import json,sys; d=json.load(sys.stdin); print('BMF' in d['disclaimer'])" < "$TMP")
assert_eq "disclaimer mentions BMF" "$HAS_BMF" "True"

# Cleanup the test Vorauszahlungen + vorauszahlungen field
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'gewstVorauszahlungen'
  WHERE id = '$COMPANY_ID';" >/dev/null
rm -f "$TMP"

summary
