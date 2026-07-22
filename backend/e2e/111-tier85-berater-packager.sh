#!/usr/bin/env bash
# e2e 111: Tier 85 — Anlage Steuererklärung packager.
#
# Validates /api/v1/accounting/berater-packager:
# the streaming ZIP endpoint that bundles every
# VORSCHAU report (EÜR + Anlage S + Bilanz + G+V
# + Anhang + Anlagenverzeichnis CSV + MANIFEST.md)
# for the Berater's year-end review.
#
# Tests:
#   1. /berater-packager reachable (200) + correct
#      content-type.
#   2. ZIP archive has 7 entries (5 PDFs + 1 CSV
#      + 1 MANIFEST.md).
#   3. Each PDF has the %PDF magic bytes.
#   4. 06_Anlagenverzeichnis.csv has the right
#      German semicolon header row.
#   5. MANIFEST.md is German + lists all 6 file
#      names + has Stammdaten.
#   6. Year validation 1999, 2101 → 400.
#   7. Cross-tenant → 401.
#   8. Missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="packager-tier85-$TS"
echo "=== Test: Berater-Paket (test tag: $TEST_TAG) ==="

# ── 1. /berater-packager reachable + content-type ──
echo
note "=== 1. /berater-packager reachable + application/zip ==="
ZIP_PATH=/tmp/berater-paket-tier85.zip
HTTP=$(curl -sS --max-time 60 -o "$ZIP_PATH" -w "%{http_code}|%{content_type}" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$HTTP" | cut -d'|' -f1)
CT=$(echo "$HTTP" | cut -d'|' -f2)
assert_eq "200" "$STATUS" "200"
assert_eq "application/zip content-type" "$CT" "application/zip"

# Verify it's a valid ZIP (PK magic)
MAGIC=$(head -c 4 "$ZIP_PATH" | od -An -tx1 | tr -d ' \n')
assert_eq "ZIP magic bytes (50 4b 03 04)" "$MAGIC" "504b0304"

# ── 2. ZIP has 7 entries ──
echo
note "=== 2. ZIP has 7 entries ==="
# unzip -l output: 3 header lines (Archive, Length, ---)
# + N entry lines + 2 footer lines (--- + "N files").
# We grep only the entry lines by requiring a
# leading length (digit) AND a date in column 3.
ENTRY_COUNT=$(unzip -l "$ZIP_PATH" | awk '/^[ ]+[0-9]+[ ]+[0-9]{2}-[0-9]{2}-[0-9]{4}/' | wc -l | tr -d ' ')
assert_eq "7 entries in ZIP" "$ENTRY_COUNT" "7"

# Verify the file names
EXPECTED_FILES=(
  "01_Anlage-EUR.pdf"
  "02_Anlage-S.pdf"
  "03_Bilanz.pdf"
  "04_Gewinn-und-Verlustrechnung.pdf"
  "05_Anhang.pdf"
  "06_Anlagenverzeichnis.csv"
  "MANIFEST.md"
)
for fname in "${EXPECTED_FILES[@]}"; do
  if unzip -l "$ZIP_PATH" | awk '/^[ ]+[0-9]+[ ]+[0-9]{2}-[0-9]{2}-[0-9]{4}/' | awk '{print $NF}' | grep -qx "$fname"; then
    assert_eq "  $fname present" "yes" "yes"
  else
    assert_eq "  $fname present" "yes" "MISSING"
  fi
done

# ── 3. Each PDF has %PDF magic ──
echo
note "=== 3. All 5 PDFs have %PDF magic bytes ==="
for fname in 01_Anlage-EUR.pdf 02_Anlage-S.pdf 03_Bilanz.pdf 04_Gewinn-und-Verlustrechnung.pdf 05_Anhang.pdf; do
  MAGIC=$(unzip -p "$ZIP_PATH" "$fname" | head -c 4 | od -An -tx1 | tr -d ' \n')
  assert_eq "  $fname PDF magic" "$MAGIC" "25504446"
done

# ── 4. Anlagenverzeichnis CSV header ──
echo
note "=== 4. 06_Anlagenverzeichnis.csv has correct German semicolon header ==="
CSV_HEADER=$(unzip -p "$ZIP_PATH" 06_Anlagenverzeichnis.csv | head -2 | tail -1)
if echo "$CSV_HEADER" | grep -q "AHK"; then
  assert_eq "  CSV header has AHK column" "yes" "yes"
else
  assert_eq "  CSV header has AHK column" "yes" "missing"
fi
if echo "$CSV_HEADER" | grep -q "Buchwert"; then
  assert_eq "  CSV header has Buchwert column" "yes" "yes"
else
  assert_eq "  CSV header has Buchwert column" "yes" "missing"
fi
if echo "$CSV_HEADER" | grep -q ";"; then
  assert_eq "  CSV uses German semicolon separator" "yes" "yes"
else
  assert_eq "  CSV uses German semicolon separator" "yes" "no semicolon"
fi

# ── 5. MANIFEST.md is German + lists all 6 files + has Stammdaten ──
echo
note "=== 5. MANIFEST.md is German + complete ==="
MANIFEST=$(unzip -p "$ZIP_PATH" MANIFEST.md)
if echo "$MANIFEST" | grep -q "Berater-Paket"; then
  assert_eq "  MANIFEST title 'Berater-Paket'" "yes" "yes"
else
  assert_eq "  MANIFEST title 'Berater-Paket'" "yes" "missing"
fi
if echo "$MANIFEST" | grep -q "01_Anlage-EUR.pdf"; then
  assert_eq "  MANIFEST references 01_Anlage-EUR.pdf" "yes" "yes"
else
  assert_eq "  MANIFEST references 01_Anlage-EUR.pdf" "yes" "missing"
fi
if echo "$MANIFEST" | grep -q "MANIFEST.md"; then
  assert_eq "  MANIFEST references MANIFEST.md itself" "yes" "yes"
else
  assert_eq "  MANIFEST references MANIFEST.md itself" "yes" "missing"
fi
if echo "$MANIFEST" | grep -q "Geschäftsjahr"; then
  assert_eq "  MANIFEST has Stammdaten section" "yes" "yes"
else
  assert_eq "  MANIFEST has Stammdaten section" "yes" "missing"
fi
if echo "$MANIFEST" | grep -qi "Vorgehensweise\|VORSCHAU"; then
  assert_eq "  MANIFEST has Vorgehensweise section" "yes" "yes"
else
  assert_eq "  MANIFEST has Vorgehensweise section" "yes" "missing"
fi

# ── 6. year validation ──
echo
note "=== 6. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 7. Cross-tenant → 401 ──
echo
note "=== 7. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 8. Missing companyId → 400 ──
echo
note "=== 8. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 \
  "$API/api/v1/accounting/berater-packager?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$ZIP_PATH"
summary
exit $?
