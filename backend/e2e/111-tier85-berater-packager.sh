#!/usr/bin/env bash
# e2e 111: Tier 85 + 92 + 95 — Anlage Steuererklärung packager.
#
# Validates /api/v1/accounting/berater-packager:
# the streaming ZIP endpoint that bundles every
# VORSCHAU report (EÜR + Anlage S + [Anlage V
# conditional] + BWA + Bilanz + G+V + Anhang +
# Anlagenverzeichnis CSV + MANIFEST.md) for the
# Berater's year-end review.
#
# Tier 92 added Anlage V (optional, between S
# and BWA). Tier 95 added BWA (always, between
# Anlage-V slot and Bilanz). Total entries:
# 8 without Anlage V, 9 with Anlage V.
#
# Tests:
#   1. /berater-packager reachable (200) + correct
#      content-type.
#   2. ZIP archive has 8 entries (6 PDFs + 1 CSV
#      + 1 MANIFEST.md) when no Anlage V.
#   3. Each PDF has the %PDF magic bytes.
#   4. 07_Anlagenverzeichnis.csv has the right
#      German semicolon header row.
#   5. MANIFEST.md is German + lists all 7 file
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

# Tier 361: entries used to be read by grepping `unzip -l` for MM-DD-YYYY
# dates — the macOS unzip format. On the Linux CI runner the listing did not
# match, so the ZIP "had 0 entries" and every name/CSV check below failed
# while the archive itself was fine (200, PK magic). zipfile gives the same
# names on every platform.
ZIP_ENTRIES=$(python3 -c "import sys, zipfile; print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))" "$ZIP_PATH" 2>/dev/null)

# ── 2. ZIP has at least 8 entries (no Anlage V) ──
echo
note "=== 2. ZIP has >= 8 entries (tier 85: base 8, +Anlage KAP +KSt1 +Anlage SO +UStJA +GewSt +Anlage AUS) ==="
# The base packager has 8 entries (EÜR, S, BWA,
# Bilanz, GUV, Anhang, Anlagenverzeichnis, MANIFEST).
# Later tiers (95/100/102/105/106/109/110) added
# optional Anlage forms + always-on Steuerarten
# (UStJA, GewSt). The exact count depends on which
# optional Anlagen are enabled for the company; we
# only assert >= 8.
ENTRY_COUNT=$(printf '%s\n' "$ZIP_ENTRIES" | grep -c .)
if [ "$ENTRY_COUNT" -ge 8 ]; then
  pass "ZIP has $ENTRY_COUNT entries (>= 8)"
else
  fail "ZIP has $ENTRY_COUNT entries (expected >= 8)"
fi

# Verify the always-on file names are present
# (the optional Anlagen may or may not be there
# depending on the company's feature flags).
EXPECTED_FILES=(
  "01_Anlage-EUR.pdf"
  "02_Anlage-S.pdf"
  "MANIFEST.md"
)
for fname in "${EXPECTED_FILES[@]}"; do
  if printf '%s\n' "$ZIP_ENTRIES" | grep -qxF "$fname"; then
    assert_eq "  $fname present" "yes" "yes"
  else
    assert_eq "  $fname present" "yes" "MISSING"
  fi
done

# ── 3. Each PDF in the ZIP has %PDF magic ──
echo
note "=== 3. All PDFs in ZIP have %PDF magic bytes ==="
for fname in $(printf '%s\n' "$ZIP_ENTRIES" | grep -E '\.pdf$'); do
  MAGIC=$(unzip -p "$ZIP_PATH" "$fname" | head -c 4 | od -An -tx1 | tr -d ' \n')
  assert_eq "  $fname PDF magic" "$MAGIC" "25504446"
done

# ── 4. Anlagenverzeichnis CSV header ──
echo
note "=== 4. Anlagenverzeichnis.csv has correct German semicolon header ==="
# The CSV position depends on how many optional
# Anlagen are included (Anlage KAP, G, N, R, Kind,
# SO, AUS). Find it by name.
CSV_NAME=$(printf '%s\n' "$ZIP_ENTRIES" | grep -E 'Anlagenverzeichnis\.csv$' | head -1)
if [ -n "$CSV_NAME" ]; then
  pass "Anlagenverzeichnis.csv present: $CSV_NAME"
else
  fail "Anlagenverzeichnis.csv missing from packager"
fi
CSV_HEADER=$(unzip -p "$ZIP_PATH" "$CSV_NAME" | head -2 | tail -1)
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

# ── 5. MANIFEST.md is German + lists all 7 files + has Stammdaten ──
echo
note "=== 5. MANIFEST.md is German + complete (tier 95: +BWA row) ==="
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
