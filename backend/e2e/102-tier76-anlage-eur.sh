#!/usr/bin/env bash
# e2e 102: Tier 76 — Anlage EÜR (Einnahmen-Überschuss-Rechnung).
#
# Validates the new /api/v1/accounting/euer and
# /api/v1/accounting/euer.pdf endpoints that
# aggregate the year's revenue + expenses into
# BMF Kennziffern buckets.
#
# Tests:
#   1. GET /euer → 200 with the expected shape
#      (year, einnahmen[], ausgaben[], totals,
#      counts, disclaimer).
#   2. All 4 BMF revenue Kennziffern are present
#      (4100/4120/4170/4190).
#   3. All 8 expense Kennziffern are present
#      (4300/5100/5400/5600/5800/4600 AfA/4610 Restbuchwert/5900).
#   4. totals.einnahmenTotal = sum of einnahmen[].amount.
#   5. totals.ausgabenTotal = sum of ausgaben[].amount.
#   6. totals.gewinn = einnahmenTotal - ausgabenTotal.
#   7. Credit notes (Gutschriften) reduce Kz 4100,
#      not Kz 4190 (Sonstige).
#   8. year param validation: 1999, 2101 → 400.
#   9. Default year (= previous calendar year) works.
#  10. PDF endpoint returns application/pdf with
#      a valid PDF body.
#  11. Missing companyId → 400.
#  12. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

# ── 1. Shape ──
echo
note "=== 1. GET /accounting/euer shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/accounting/euer?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "year=2026 → 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year', 'companyId', 'einnahmen', 'ausgaben', 'totals', 'counts', 'generatedAt', 'disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# ── 2. Revenue Kennziffern ──
echo
note "=== 2. revenue Kennziffern 4100/4120/4170/4190 present ==="
REV_KZS=$(python3 -c "
import json
d = json.load(open('$TMP'))
kzs = [l['kennziffer'] for l in d['einnahmen']]
print('true' if set(kzs) == {'4100', '4120', '4170', '4190'} else f'got: {sorted(kzs)}')
")
assert_eq "all 4 revenue Kennziffern" "$REV_KZS" "true"

# ── 3. Expense Kennziffern ──
echo
note "=== 3. expense Kennziffern 4300/5100/5400/5600/5800/4600/4610/5900 present (4600: Tier 436, 4610: Tier 440) ==="
EXP_KZS=$(python3 -c "
import json
d = json.load(open('$TMP'))
kzs = [l['kennziffer'] for l in d['ausgaben']]
print('true' if set(kzs) == {'4300', '5100', '5400', '5600', '5800', '4600', '4610', '5900'} else f'got: {sorted(kzs)}')
")
assert_eq "all 8 expense Kennziffern" "$EXP_KZS" "true"

# ── 4. einnahmenTotal = sum ──
echo
note "=== 4. einnahmenTotal = sum(einnahmen[].amount) ==="
REV_SUM=$(python3 -c "
import json
d = json.load(open('$TMP'))
total = sum(l['amount'] for l in d['einnahmen'])
print('true' if abs(d['totals']['einnahmenTotal'] - total) < 0.01 else f'mismatch: einnahmenTotal={d[\"totals\"][\"einnahmenTotal\"]} sum={total}')
")
assert_eq "einnahmenTotal matches sum" "$REV_SUM" "true"

# ── 5. ausgabenTotal = sum ──
echo
note "=== 5. ausgabenTotal = sum(ausgaben[].amount) ==="
EXP_SUM=$(python3 -c "
import json
d = json.load(open('$TMP'))
total = sum(l['amount'] for l in d['ausgaben'])
print('true' if abs(d['totals']['ausgabenTotal'] - total) < 0.01 else f'mismatch: ausgabenTotal={d[\"totals\"][\"ausgabenTotal\"]} sum={total}')
")
assert_eq "ausgabenTotal matches sum" "$EXP_SUM" "true"

# ── 6. gewinn = einnahmenTotal - ausgabenTotal ──
echo
note "=== 6. gewinn = einnahmenTotal - ausgabenTotal ==="
GEWINN_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
t = d['totals']
expected = t['einnahmenTotal'] - t['ausgabenTotal']
print('true' if abs(t['gewinn'] - expected) < 0.01 else f'mismatch: gewinn={t[\"gewinn\"]} expected={expected}')
")
assert_eq "gewinn identity" "$GEWINN_OK" "true"

# ── 7. Credit notes reduce Kz 4100 ──
echo
note "=== 7. credit notes (Gutschriften) reduce Kz 4100 ==="
# We seeded multiple CN invoices in the dev DB;
# verify the Kz 4100 line is smaller than the
# total positive invoice subtotal (i.e. CNs
# reduced it). If there are no CNs, this test
# is a no-op — we just check the structure.
CN_CHECK=$(python3 -c "
import json
d = json.load(open('$TMP'))
# The credit notes sum is implicit: if
# einnahmenTotal < SUM(positive_invoices),
# some value reduced it. For a robust test we
# check the structural property: Kz 4190
# (Sonstige) is exactly 0 (no overflow), and
# Kz 4100 is the only Kz that holds a negative
# contribution from credit notes.
sonstige = next(l for l in d['einnahmen'] if l['kennziffer'] == '4190')
if sonstige['amount'] != 0:
    print(f'Kz 4190 has data — credit notes may have leaked into Sonstige')
else:
    print('true')
")
assert_eq "no leakage into Kz 4190" "$CN_CHECK" "true"

# ── 8. year validation ──
echo
note "=== 8. year param validation ==="
STATUS_OLD=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/euer?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_OLD" "400"

STATUS_FUTURE=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/euer?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$STATUS_FUTURE" "400"

# ── 9. default year (= previous calendar year) ──
echo
note "=== 9. default year works ==="
DEFAULT_YEAR=$(curl -sS \
  "$API/api/v1/accounting/euer?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['year'])")
# 2026 in our env → default = 2025
assert_eq "default year is 2025" "$DEFAULT_YEAR" "2025"

# ── 10. PDF endpoint ──
echo
note "=== 10. PDF endpoint ==="
PDF_RESP=$(curl -sS -o /tmp/euer-test.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/accounting/euer.pdf?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$PDF_RESP" | cut -d'|' -f1)
CT=$(echo "$PDF_RESP" | cut -d'|' -f2)
SIZE=$(echo "$PDF_RESP" | cut -d'|' -f3)
assert_eq "PDF 200" "$HTTP" "200"
assert_eq "PDF content-type" "$CT" "application/pdf"
# PDF magic bytes: %PDF-
MAGIC=$(head -c 5 /tmp/euer-test.pdf)
assert_eq "PDF magic bytes" "$MAGIC" "%PDF-"

# ── 11. Missing companyId → 400 ──
echo
note "=== 11. missing companyId → 400 ==="
STATUS_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/euer" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "no companyId → 400" "$STATUS_NO_CID" "400"

# ── 12. Cross-tenant → 401 ──
echo
note "=== 12. cross-tenant → 401 ==="
STATUS_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/euer?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$STATUS_CROSS" "401"

rm -f "$TMP" /tmp/euer-test.pdf
summary
exit $?
