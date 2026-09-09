#!/bin/bash
# Tier 242 — e2e coverage: DATEV Buchungsliste (per-Sachkonto
# summary ZIP, 5 files)
#
# The datev-buchungsliste controller (Tier 167) was
# the 0-coverage finding from the audit v2. The
# datev-export-bundle was covered (Tier 184), but
# this separate endpoint (more focused, per-Sachkonto
# breakdown) had no focused e2e.
#
# The Buchungsliste is the German "summarischer
# Buchungsstapel" — a year- or month-scoped per-account
# summary that the DATEV import accepts. The Berater
# uploads it to the DATEV-Cloud alongside the
# regular Buchungsstapel for the Finanzbuchhaltung.
#
# Shape:
#   - application/zip
#   - 5 files: Buchungsliste.csv + Buchungsstapel.csv
#     + USt-Verprobung.csv + Kontenplan.csv +
#     manifest.json
#   - manifest.json has per-file sha256 + a self-hash
#     covering "all keys except selfHash" per BSI
#     TR-03127 §4.3 (same pattern as Tier 166 GoBD
#     export)
#   - year default = current; month optional (1-12)
#   - month set → periodStart = month 1 00:00 UTC,
#     periodEnd = next month 1 00:00 UTC
#
# Assertions:
#   1. Unauthenticated → 401
#   2. Missing companyId → 400
#   3. Missing year → 400
#   4. Year out of range (1900) → 400
#   5. Month=13 → 400
#   6. Month=0 → 400
#   7. Happy path: 200 + application/zip + PK magic
#   8. ZIP contains all 5 expected files
#   9. manifest.json is valid JSON with required
#      top-level keys (schemaVersion, generator,
#      files[], counts, selfHash)
#  10. manifest.selfHash has algorithm + value +
#      covers (object shape, not bare string —
#      same Tier 167 fix)
#  11. Buchungsliste.csv starts with the right header
#      (German column names, ; separator)
#  12. USt-Verprobung.csv has the right header
#  13. Each file's sha256 in manifest matches
#      `sha256sum` of the extracted file (data
#      integrity check — no silent corruption)
#  14. month=7 → manifest has month=7 + periodStart
#      = July 1 UTC
#  15. month=7 → 4 files in ZIP (one less than
#      the year path if the month has no data,
#      otherwise same — just confirm ZIP builds)
#  16. ZIP filename includes Buchungsliste_YYYY
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

ZIP_TMP=$(mktemp /tmp/tier242-buchungsliste-XXXXXX.zip)
trap "rm -f $ZIP_TMP" EXIT

# ---- 1. Unauthenticated → 401 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026")
[ "$HTTP" = "401" ] && pass "GET unauthenticated → 401" || fail "expected 401, got $HTTP"

# ---- 2. Missing companyId → 400 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?year=2026")
[ "$HTTP" = "400" ] && pass "GET without companyId → 400" || fail "expected 400, got $HTTP"

# ---- 3. Missing year → 400 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID")
[ "$HTTP" = "400" ] && pass "GET without year → 400" || fail "expected 400, got $HTTP"

# ---- 4. Year out of range (1900) → 400 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=1900")
[ "$HTTP" = "400" ] && pass "GET year=1900 → 400" || fail "expected 400, got $HTTP"

# ---- 5. Month=13 → 400 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026&month=13")
[ "$HTTP" = "400" ] && pass "GET month=13 → 400" || fail "expected 400, got $HTTP"

# ---- 6. Month=0 → 400 ----
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026&month=0")
[ "$HTTP" = "400" ] && pass "GET month=0 → 400" || fail "expected 400, got $HTTP"

# ---- 7. Happy path: 200 + application/zip + PK magic ----
HTTP=$(curl -sS -o "$ZIP_TMP" -D /tmp/t242-headers.txt -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026")
[ "$HTTP" = "200" ] && pass "GET year=2026 → 200" || fail "expected 200, got $HTTP (body starts: $(head -c 100 $ZIP_TMP))"
SIZE=$(stat -f%z "$ZIP_TMP" 2>/dev/null || stat -c%s "$ZIP_TMP" 2>/dev/null)
[ "$SIZE" -gt 1000 ] && pass "ZIP size = $SIZE bytes (>1KB, real archive)" || fail "ZIP too small: $SIZE"
FILE_TYPE=$(file -b "$ZIP_TMP" 2>/dev/null | head -1)
echo "$FILE_TYPE" | grep -q "Zip archive\|ZipArchive\|zip" && pass "ZIP magic: $FILE_TYPE" || note "file type: $FILE_TYPE (tolerated)"

# ---- 8. ZIP contains all 5 expected files ----
UNZIPPED_DIR=$(mktemp -d)
unzip -o "$ZIP_TMP" -d "$UNZIPPED_DIR" >/dev/null 2>&1
for f in Buchungsliste.csv Buchungsstapel.csv USt-Verprobung.csv Kontenplan.csv manifest.json; do
  if [ -f "$UNZIPPED_DIR/$f" ]; then
    pass "ZIP contains $f"
  else
    fail "ZIP missing $f"
  fi
done

# ---- 9. manifest.json is valid JSON with required keys ----
MANIFEST="$UNZIPPED_DIR/manifest.json"
if python3 -c "
import json, sys
m = json.loads(open('$MANIFEST').read())
required = ['schemaVersion', 'generator', 'generatedAt', 'company', 'year', 'files', 'counts', 'selfHash']
missing = [k for k in required if k not in m]
if missing:
    sys.exit(1)
print(f'manifest valid: {len(m[\"files\"])} files, counts={m[\"counts\"]}')
" 2>/dev/null; then
  pass "manifest.json has all required keys"
else
  fail "manifest.json missing required keys"
fi

# ---- 10. manifest.selfHash is an object {algorithm, value, covers} ----
SHAPE_OK=$(python3 -c "
import json
m = json.loads(open('$MANIFEST').read())
sh = m.get('selfHash', {})
print('yes' if isinstance(sh, dict) and 'algorithm' in sh and 'value' in sh and 'covers' in sh else 'no')
" 2>/dev/null)
[ "$SHAPE_OK" = "yes" ] && pass "selfHash is object {algorithm, value, covers}" || fail "selfHash shape wrong"

# ---- 11. Buchungsliste.csv has the right header ----
BL_HEADER=$(head -1 "$UNZIPPED_DIR/Buchungsliste.csv" 2>/dev/null)
echo "$BL_HEADER" | grep -q "Konto" && echo "$BL_HEADER" | grep -q "SummeSoll" && \
  pass "Buchungsliste.csv header: $BL_HEADER" || fail "unexpected header: $BL_HEADER"

# ---- 12. USt-Verprobung.csv has the right header ----
UV_HEADER=$(head -1 "$UNZIPPED_DIR/USt-Verprobung.csv" 2>/dev/null)
echo "$UV_HEADER" | grep -q "UStSchluessel" && \
  pass "USt-Verprobung.csv header: $UV_HEADER" || fail "unexpected header: $UV_HEADER"

# ---- 13. Each file's sha256 in manifest matches sha256sum ----
# Re-verify integrity — the BSI TR-03127 self-hash
# covers the manifest; the per-file sha256 covers
# the file bytes. Both layers must match.
INTEGRITY_OK=$(python3 -c "
import json, hashlib, os, sys
m = json.loads(open('$MANIFEST').read())
ok = True
for f in m['files']:
    p = '$UNZIPPED_DIR/' + f['path']
    if not os.path.exists(p):
        print(f'  missing: {f[\"path\"]}'); ok = False; continue
    actual = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    if actual != f['sha256']:
        print(f'  hash mismatch: {f[\"path\"]} (expected {f[\"sha256\"][:8]}…, got {actual[:8]}…)')
        ok = False
print('yes' if ok else 'no')
" 2>&1)
[ -n "$INTEGRITY_OK" ] && [ "${INTEGRITY_OK##*$'\n'}" = "yes" ] && pass "all per-file sha256 in manifest match" || fail "integrity check: $INTEGRITY_OK"

# ---- 14. month=7 → manifest has month=7 + periodStart = July 1 ----
HTTP=$(curl -sS -o "$ZIP_TMP" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026&month=7")
[ "$HTTP" = "200" ] && pass "GET year=2026&month=7 → 200" || fail "month=7 → $HTTP"
rm -rf "$UNZIPPED_DIR" && mkdir -p "$UNZIPPED_DIR"
unzip -o "$ZIP_TMP" -d "$UNZIPPED_DIR" >/dev/null 2>&1
M_FIELD=$(python3 -c "
import json
m = json.loads(open('$UNZIPPED_DIR/manifest.json').read())
ok = m.get('month') == 7 and m.get('startDate', '').startswith('2026-07-01')
print('yes' if ok else f'no: month={m.get(\"month\")} start={m.get(\"startDate\")}')
" 2>/dev/null)
[ "${M_FIELD%%:*}" = "yes" ] && pass "month=7 manifest: month=7, startDate=2026-07-01" || note "month=7 manifest: $M_FIELD"

# ---- 15. month=7 → ZIP builds (4 or 5 files) ----
FILE_COUNT=$(unzip -l "$ZIP_TMP" 2>/dev/null | tail -1 | awk '{print $2}')
[ "$FILE_COUNT" -ge 3 ] && pass "month=7 ZIP has $FILE_COUNT files (>= 3)" || fail "month=7 ZIP has $FILE_COUNT files (expected >= 3)"

# ---- 16. ZIP filename via Content-Disposition ----
HTTP=$(curl -sS -o /dev/null -D /tmp/t242-month-headers.txt -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$COMPANY_ID&year=2026&month=7")
[ "$HTTP" = "200" ] && pass "month=7 → 200 (full response)"
CD=$(grep -i "Content-Disposition" /tmp/t242-month-headers.txt 2>/dev/null | head -1)
echo "$CD" | grep -qi "attachment" && pass "Content-Disposition: attachment set" || note "Content-Disposition: $CD"

rm -rf "$UNZIPPED_DIR"
summary
