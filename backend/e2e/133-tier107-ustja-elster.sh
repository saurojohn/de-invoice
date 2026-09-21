#!/usr/bin/env bash
# Tier 107 — UStJA ELSTER XML
# (Umsatzsteuerjahreserklärung, BMF Vordruck 2024).
#
# Validates the new ELSTER export for the annual
# USt return. Same Datenlieferung envelope as the
# UStVA path; the AnlageName is "AnlageUStJA" +
# the Zeitraum is the full calendar year (no
# Quartal or Monat).
#
# v1: extends the existing elster.service.ts with
# generateUstjaElsterXml() + generateUstjaAsciiPreview()
# for the UStJA Datenlieferung. The 12-month
# consolidation is already done by UstjaService.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)

# ===== 1. /ustja/elster-xml returns valid Datenlieferung =====
echo
note "=== 1. /ustja/elster-xml returns valid Datenlieferung ==="
ELSTER_HEAD=$(curl -sS -o /tmp/ustja-elster-$TS.xml -w "%{http_code}|%{content_type}|%{size_download}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2026")
ELSTER_STATUS=$(echo "$ELSTER_HEAD" | cut -d'|' -f1)
ELSTER_CTYPE=$(echo "$ELSTER_HEAD" | cut -d'|' -f2)
ELSTER_SIZE=$(echo "$ELSTER_HEAD" | cut -d'|' -f3)
assert_eq "ELSTER status 200" "$ELSTER_STATUS" "200"
assert_eq "ELSTER content-type" "$ELSTER_CTYPE" "application/xml; charset=utf-8"
test "$ELSTER_SIZE" -gt 500 && pass "ELSTER size = $ELSTER_SIZE bytes" || fail "ELSTER size too small: $ELSTER_SIZE"

# ===== 2. XML is well-formed (parseable by Python ElementTree) =====
echo
note "=== 2. XML is well-formed ==="
WELLFORMED=$(python3 -c "
import xml.etree.ElementTree as ET
try:
  ET.parse('/tmp/ustja-elster-$TS.xml')
  print('True')
except Exception as e:
  print('False')
")
assert_eq "XML parseable by Python ElementTree" "$WELLFORMED" "True"

# ===== 3. Kennzahlen: the USt 2 A 2026 numbers, with the /ustja values =====
# Tier 417: this checked for an invented set (020/026/021/027/036/041/043/044/
# 066/067/039/068/069/081 — "081" as the Differenzbetrag, which on the monthly
# form is the 19 % base). The export now writes the official annual numbers.
echo
note "=== 3. Kennzahlen: USt 2 A 2026 numbers, same values as /ustja ==="
api_get "/api/v1/ustva/ustja?companyId=$COMPANY_ID&year=2026"
printf '%s' "$BODY" > /tmp/ustja-json-$TS.json
KZCHECK=$(python3 - /tmp/ustja-elster-$TS.xml /tmp/ustja-json-$TS.json <<'PY2'
import json, re, sys
xml = open(sys.argv[1]).read()
d = json.load(open(sys.argv[2]))
got = {int(k): int(v) for k, v in re.findall(r'B-Kz(\d{3})=([+-]\d{12,13})', xml)}
official = {177,275,155,156,741,752,781,793,798,799,846,847,877,878,209,721,205,320,761,467}
unknown = sorted(set(got) - official)
want = {}
for l in d['lines']:
    if not l['kennziffer']:
        continue
    tax_only = l.get('net') is None and l.get('amount') is None
    v = l.get('vat') if tax_only else (l.get('net') if l.get('net') is not None else l.get('amount'))
    if v:
        want[int(l['kennziffer'])] = round(v * 100)
print(f"{unknown}|{got == want}|{len(got)}")
PY2
)
assert_eq "no Kennzahl outside the USt 2 A 2026 set (was 020/066/068/069/081 …)" "$(echo "$KZCHECK" | cut -d'|' -f1)" "[]"
assert_eq "every B-Kz value equals its /ustja line (cents)" "$(echo "$KZCHECK" | cut -d'|' -f2)" "True"
XML_KZ_COUNT=$(echo "$KZCHECK" | cut -d'|' -f3)

# ===== 4. TransferHeader has correct Anlage + Zeitraum (full year) =====
echo
note "=== 4. TransferHeader structure ==="
ANLAGE=$(grep -oE '<AnlageName>[^<]+' /tmp/ustja-elster-$TS.xml | head -1)
VORGANG=$(grep -oE '<Vorgang>[^<]+' /tmp/ustja-elster-$TS.xml | head -1)
DATENART=$(grep -oE '<DatenArt>[^<]+' /tmp/ustja-elster-$TS.xml | head -1)
JAHR=$(grep -oE '<Jahr>[^<]+' /tmp/ustja-elster-$TS.xml | head -1)
[[ "$ANLAGE" == "<AnlageName>AnlageUStJA" ]] && pass "AnlageName = AnlageUStJA" || fail "AnlageName = $ANLAGE"
[[ "$VORGANG" == "<Vorgang>UStJA" ]] && pass "Vorgang = UStJA" || fail "Vorgang = $VORGANG"
[[ "$DATENART" == "<DatenArt>UStJA" ]] && pass "DatenArt = UStJA" || fail "DatenArt = $DATENART"
[[ "$JAHR" == "<Jahr>2026" ]] && pass "Zeitraum Jahr = 2026" || fail "Jahr = $JAHR"

# Anlage USTJA=1 attribute present
ANLAGE_FLAG=$( (grep -c '<Anlage USTJA=' /tmp/ustja-elster-$TS.xml 2>/dev/null || true) | head -1 | tr -d ' \n')
ANLAGE_FLAG=${ANLAGE_FLAG:-0}
test "$ANLAGE_FLAG" -ge 1 && pass "Anlage USTJA=1 flag present" || fail "Anlage USTJA=1 missing"

# No Quartal / Monat in Zeitraum (whole year only).
# `grep -c` returns exit 1 when no matches — the
# `|| true` keeps `set -e` from aborting the script.
NO_QUARTAL=$( (grep -c '<Quartal>' /tmp/ustja-elster-$TS.xml 2>/dev/null || true) | head -1 | tr -d ' \n')
NO_MONAT=$( (grep -c '<Monat>' /tmp/ustja-elster-$TS.xml 2>/dev/null || true) | head -1 | tr -d ' \n')
NO_QUARTAL=${NO_QUARTAL:-0}
NO_MONAT=${NO_MONAT:-0}
assert_eq "no Quartal in Zeitraum" "$NO_QUARTAL" "0"
assert_eq "no Monat in Zeitraum" "$NO_MONAT" "0"

# ===== 5. format=ascii returns plain text with all Kz lines =====
echo
note "=== 5. format=ascii returns plain text ==="
ASCII_HEAD=$(curl -sS -o /tmp/ustja-ascii-$TS.txt -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2026&format=ascii")
ASCII_STATUS=$(echo "$ASCII_HEAD" | cut -d'|' -f1)
ASCII_CTYPE=$(echo "$ASCII_HEAD" | cut -d'|' -f2)
assert_eq "ASCII status 200" "$ASCII_STATUS" "200"
assert_eq "ASCII content-type" "$ASCII_CTYPE" "text/plain; charset=utf-8"

ASCII_KZ_COUNT=$(grep -c '^B-Kz' /tmp/ustja-ascii-$TS.txt 2>/dev/null || echo 0)
ASCII_KZ_COUNT=${ASCII_KZ_COUNT:-0}
assert_eq "the Kennzahlen list has the same Kz lines as the XML" "$ASCII_KZ_COUNT" "$XML_KZ_COUNT"
grep -q "Keine amtliche Upload-Datei" /tmp/ustja-ascii-$TS.txt && pass "the list says it is not an ELSTER upload" \
  || fail "the list still presents itself as an upload format"

# ===== 6. Vorsteuer: Kz 320 + 761 + 467 in the XML = totals.vorsteuer =====
echo
note "=== 6. Kz 320 + 761 + 467 = totals.vorsteuer ==="
VST=$(python3 - /tmp/ustja-elster-$TS.xml /tmp/ustja-json-$TS.json <<'PY2'
import json, re, sys
xml = open(sys.argv[1]).read()
t = json.load(open(sys.argv[2]))['totals']
got = {int(k): int(v) for k, v in re.findall(r'B-Kz(\d{3})=([+-]\d{12,13})', xml)}
print(abs(sum(got.get(k, 0) for k in (320, 761, 467)) - round(t['vorsteuer'] * 100)) <= 1)
PY2
)
assert_eq "Vorsteuer Kennzahlen add up to totals.vorsteuer" "$VST" "True"
rm -f /tmp/ustja-json-$TS.json

# ===== 7. ?download=1 sets Content-Disposition =====
echo
note "=== 7. ?download=1 sets Content-Disposition ==="
DOWNLOAD_HEAD=$(curl -sS -o /dev/null -D /tmp/ustja-headers-$TS.txt -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2026&download=1")
assert_eq "download=1 status 200" "$DOWNLOAD_HEAD" "200"
DISPOSITION=$(grep -i '^content-disposition:' /tmp/ustja-headers-$TS.txt 2>&1 | head -1)
[[ "$DISPOSITION" == *"attachment"* ]] && pass "Content-Disposition = attachment ($DISPOSITION)" || fail "Content-Disposition not attachment: $DISPOSITION"
FILENAME=$(echo "$DISPOSITION" | grep -oE 'filename="[^"]+"')
[[ "$FILENAME" == *"UStJA_2026"* ]] && pass "filename has UStJA_2026" || fail "filename wrong: $FILENAME"

# ===== 8. Steuernummer normalisation (10/11/13 digits) =====
echo
note "=== 8. Steuernummer normalised to 13 digits in <Steuernummer> ==="
STEUER=$(grep -oE '<Steuernummer>[0-9]+' /tmp/ustja-elster-$TS.xml | head -1 | sed 's/.*>//')
STEUER_LEN=${#STEUER}
assert_eq "Steuernummer is 13 digits" "$STEUER_LEN" "13"

# ===== 9. Year validation =====
echo
note "=== 9. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 10. Cross-tenant =====
echo
note "=== 10. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 11. Missing companyId → 400 =====
echo
note "=== 11. Missing companyId → 400 ==="
STATUS_NCI=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?year=2026")
assert_eq "no companyId → 400" "$STATUS_NCI" "400"

# ===== 12. Missing taxId → 400 =====
echo
note "=== 12. Missing taxId in company profile → 400 ==="
ORIG_TAXID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"taxId\" FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d ' \n')
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET \"taxId\"=NULL WHERE id='$COMPANY_ID';" >/dev/null
STATUS_NOTAX=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/ustva/ustja/elster-xml?companyId=$COMPANY_ID&year=2026")
assert_eq "no taxId → 400" "$STATUS_NOTAX" "400"
# Restore taxId
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET \"taxId\"='$ORIG_TAXID' WHERE id='$COMPANY_ID';" >/dev/null
pass "restored taxId"

# ===== 13. ELSTER Berater packager row? NOT included =====
echo
note "=== 13. UStJA ELSTER XML is a separate download, NOT in Berater packager ==="
# The Berater packager contains the UStJA PDF (not
# the ELSTER XML). The ELSTER XML is a user-facing
# download button on the UStJA section. Verify the
# PDF is still in the packager.
ZIP_PATH=/tmp/berater-ustja-elster-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"
mkdir -p /tmp/berater-ustja-elster-$TS && cd /tmp/berater-ustja-elster-$TS && unzip -o -q "$ZIP_PATH" && cd - >/dev/null
USTJA_PDF=$(find /tmp/berater-ustja-elster-$TS -name "*UStJA.pdf" | head -1)
[[ -n "$USTJA_PDF" ]] && pass "UStJA.pdf still in packager (PDF, not ELSTER XML)" || fail "UStJA.pdf missing"
rm -rf /tmp/berater-ustja-elster-$TS "$ZIP_PATH" /tmp/ustja-elster-$TS.xml /tmp/ustja-ascii-$TS.txt /tmp/ustja-headers-$TS.txt

summary
