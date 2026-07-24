#!/usr/bin/env bash
# Tier 98 — Anlage KAP (Kapitalerträge,
# § 20 EStG).
#
# Validates the new AnlageKAPService + the
# /api/v1/accounting/anlage-kap endpoint + the
# /api/v1/accounting/anlage-kap.pdf endpoint +
# the Berater packager conditional inclusion.
#
# v1 heuristic: bank transactions with
# "Zins" / "Dividende" / "Ausschüttung" in
# the purpose field are tentatively classified
# as Kapitalerträge. The opt-in flag
# `Company.settings.anlageKAP === true` gates
# whether the report is generated.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)
# e2e 123 is read-only — no fixtures to
# wipe. Anlage KAP is a derived report
# from existing bank transactions.

# ===== 1. /anlage-kap shape: 10 einnahmen + 6 abzuege lines =====
echo
note "=== 1. /anlage-kap shape (10 einnahmen + 6 abzuege) ==="
api_get "/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

EINNAHMEN_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['einnahmen']))" < "$TMP")
ABZUEGE_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['abzuege']))" < "$TMP")
assert_eq "einnahmen count == 10" "$EINNAHMEN_COUNT" "10"
assert_eq "abzuege count == 6" "$ABZUEGE_COUNT" "6"

# ===== 2. Key Kennziffern present =====
echo
note "=== 2. Key Kennziffern (7100-7140 + 7300) ==="
for kz in 7100 7110 7120 7130 7140 7150 7160 7300 7400 7500; do
  HAS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
all_lines = d['einnahmen'] + d['abzuege']
print(any(l['kennziffer'] == '$kz' for l in all_lines))
" < "$TMP")
  assert_eq "Kennziffer $kz present" "$HAS" "True"
done
rm -f "$TMP"

# ===== 3. Zu versteuern = max(0, einnahmen - abzuege) =====
echo
note "=== 3. Zu versteuern = max(0, einnahmen - abzuege) ==="
api_get "/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

# In v1, bank transactions may or may not
# match the heuristic depending on dev DB
# state. The math identity must hold
# regardless of the values.
ZUV_CHECK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
e = d['totals']['einnahmenTotal']
a = d['totals']['abzuegeTotal']
z = d['totals']['zuVersteuern']
expected = max(0, e - a)
print(f'{abs(z - expected) < 0.01}|{e}|{a}|{z}|{expected}')
" < "$TMP")
assert_eq "zuVersteuern identity" "$(echo "$ZUV_CHECK" | cut -d'|' -f1)" "True"
pass "einnahmen=$(echo "$ZUV_CHECK" | cut -d'|' -f2), abzuege=$(echo "$ZUV_CHECK" | cut -d'|' -f3), zuVersteuern=$(echo "$ZUV_CHECK" | cut -d'|' -f4)"
rm -f "$TMP"

# ===== 4. 25% Abgeltungssteuer + 5.5% Soli =====
echo
note "=== 4. Abgeltungssteuer 25% + Soli 5.5% ==="
api_get "/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

ABG_CHECK=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
abg = d['abgeltungssteuer']
print(f'{abg[\"rate\"]}|{abg[\"soliRate\"]}|{abg[\"expectedSteuer\"]}|{abg[\"expectedSoli\"]}')
" < "$TMP")
RATE=$(echo "$ABG_CHECK" | cut -d'|' -f1)
SOLI=$(echo "$ABG_CHECK" | cut -d'|' -f2)
assert_eq "Abgeltungssteuer rate == 0.25" "$RATE" "0.25"
assert_eq "Soli rate == 0.055" "$SOLI" "0.055"
rm -f "$TMP"

# ===== 5. /anlage-kap.pdf returns valid PDF =====
echo
note "=== 5. /anlage-kap.pdf returns valid PDF ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-kap-$TS.pdf -w "%{http_code}|%{content_type}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kap.pdf?companyId=$COMPANY_ID&year=2026")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_MAGIC=$(head -c 4 /tmp/anlage-kap-$TS.pdf | xxd -p)
assert_eq "PDF 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
assert_eq "PDF magic bytes" "$PDF_MAGIC" "25504446"
PDF_SIZE=$(wc -c < /tmp/anlage-kap-$TS.pdf)
pass "PDF size = $PDF_SIZE bytes"
rm -f /tmp/anlage-kap-$TS.pdf

# ===== 6. Year validation =====
echo
note "=== 6. Year validation ==="
STATUS_YEAR_LOW=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=1999")
STATUS_YEAR_HIGH=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2101")
assert_eq "year=1999 → 400" "$STATUS_YEAR_LOW" "400"
assert_eq "year=2101 → 400" "$STATUS_YEAR_HIGH" "400"

# ===== 7. Missing companyId =====
echo
note "=== 7. Missing companyId → 400 ==="
STATUS_NOCO=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kap?year=2026")
assert_eq "missing companyId → 400" "$STATUS_NOCO" "400"

# ===== 8. Cross-tenant =====
echo
note "=== 8. Cross-tenant 401 ==="
STATUS_XT=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: 00000000-0000-0000-0000-000000000000" \
  -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026")
assert_eq "cross-tenant → 401" "$STATUS_XT" "401"

# ===== 9. Sparer-Pauschbetrag is the default 1000 EUR =====
echo
note "=== 9. Sparer-Pauschbetrag default == 1000 EUR ==="
api_get "/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

PAUSCH=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
for l in d['abzuege']:
  if l['kennziffer'] == '7300':
    print(l['amount'])
    break
" < "$TMP")
assert_eq "Sparer-Pauschbetrag (7300) == 1000" "$PAUSCH" "1000"
rm -f "$TMP"

# ===== 10. Berater packager includes 03_Anlage-KAP when KAP-relevant =====
echo
note "=== 10. Berater packager conditional Anlage KAP ==="
# The KAP is included if (a) the company
# has matched bank transactions OR (b)
# settings.anlageKAP === true. v1: we
# always force includeAnlageKAP via the
# opt-in flag for the test, then check
# the packager manifest.

# Force opt-in for this test
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = COALESCE(settings, '{}'::jsonb) || '{\"anlageKAP\": true}'::jsonb
  WHERE id = '$COMPANY_ID';" >/dev/null

# Download packager ZIP
ZIP_PATH=/tmp/berater-kap-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

# Unzip and check
mkdir -p /tmp/berater-kap-$TS && cd /tmp/berater-kap-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

# Manifest mentions Anlage KAP
MANIFEST_HAS_KAP=$(grep -c "Anlage KAP" /tmp/berater-kap-$TS/MANIFEST.md 2>/dev/null || echo 0)
[[ "$MANIFEST_HAS_KAP" -ge 1 ]] && pass "MANIFEST mentions Anlage KAP ($MANIFEST_HAS_KAP lines)" || fail "MANIFEST missing Anlage KAP"

# Anlage KAP PDF present (could be 03 or 04 depending on V)
KAP_PDF_FOUND=""
for n in 03 04; do
  if [[ -f "/tmp/berater-kap-$TS/${n}_Anlage-KAP.pdf" ]]; then
    KAP_PDF_FOUND="$n"
    break
  fi
done
[[ -n "$KAP_PDF_FOUND" ]] && pass "Anlage-KAP.pdf present at position $KAP_PDF_FOUND" || fail "Anlage-KAP.pdf not found in packager"

# Anlage KAP PDF is a real PDF
if [[ -n "$KAP_PDF_FOUND" ]]; then
  KAP_MAGIC=$(head -c 4 "/tmp/berater-kap-$TS/${KAP_PDF_FOUND}_Anlage-KAP.pdf" | xxd -p)
  assert_eq "Anlage KAP PDF magic bytes" "$KAP_MAGIC" "25504446"
fi

# Cleanup
rm -rf /tmp/berater-kap-$TS "$ZIP_PATH"

# Restore settings
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\" SET settings = settings - 'anlageKAP'
  WHERE id = '$COMPANY_ID';" >/dev/null

# ===== 11. Berater packager EXCLUDES Anlage KAP when opt-out =====
echo
note "=== 11. Berater packager excludes Anlage KAP when no KAP data ==="
# Without anlageKAP opt-in AND no matching
# bank transactions, the packager should
# NOT include Anlage-KAP.pdf.
ZIP_PATH=/tmp/berater-no-kap-$TS.zip
curl -sS -o "$ZIP_PATH" -w "ZIP:%{http_code}\n" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=2026"

mkdir -p /tmp/berater-no-kap-$TS && cd /tmp/berater-no-kap-$TS && unzip -o -q "$ZIP_PATH"
cd - >/dev/null

KAP_PDF_ABSENT=$(find /tmp/berater-no-kap-$TS -name "*Anlage-KAP.pdf" 2>/dev/null | wc -l || true)
KAP_PDF_ABSENT=$(echo "$KAP_PDF_ABSENT" | tr -d ' \n')
KAP_PDF_ABSENT=${KAP_PDF_ABSENT:-0}
assert_eq "no Anlage-KAP.pdf in packager (opt-out)" "$KAP_PDF_ABSENT" "0"

MANIFEST_KAP_ABSENT=$(grep -c "Anlage KAP" /tmp/berater-no-kap-$TS/MANIFEST.md 2>/dev/null || true)
MANIFEST_KAP_ABSENT=$(echo "$MANIFEST_KAP_ABSENT" | tr -d ' \n')
MANIFEST_KAP_ABSENT=${MANIFEST_KAP_ABSENT:-0}
assert_eq "no Anlage KAP in MANIFEST (opt-out)" "$MANIFEST_KAP_ABSENT" "0"

rm -rf /tmp/berater-no-kap-$TS "$ZIP_PATH"

# ===== 12. counts + disclaimer =====
echo
note "=== 12. counts.bankTransactions + disclaimer present ==="
api_get "/api/v1/accounting/anlage-kap?companyId=$COMPANY_ID&year=2026"
TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"

HAS_COUNTS=$(python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'{c[\"bankTransactions\"] >= 0}|{c[\"matchedZinsTransactions\"] >= 0}|{c[\"matchedDividendeTransactions\"] >= 0}')
" < "$TMP")
assert_eq "bankTransactions count present" "$(echo "$HAS_COUNTS" | cut -d'|' -f1)" "True"
assert_eq "matchedZinsTransactions count present" "$(echo "$HAS_COUNTS" | cut -d'|' -f2)" "True"
assert_eq "matchedDividendeTransactions count present" "$(echo "$HAS_COUNTS" | cut -d'|' -f3)" "True"

DISCLAIMER_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['disclaimer']))" < "$TMP")
test "$DISCLAIMER_LEN" -gt 200 && pass "disclaimer length=$DISCLAIMER_LEN" || fail "disclaimer too short ($DISCLAIMER_LEN)"
rm -f "$TMP"

summary
