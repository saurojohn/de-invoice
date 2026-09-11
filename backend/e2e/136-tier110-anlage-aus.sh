#!/usr/bin/env bash
# Tier 110 — Anlage AUS (Ausländische Einkünfte,
# § 34d EStG). The 9th Anlage form — for income
# sourced outside Germany. Validates:
#
#   - GET  /anlage-aus returns empty for fresh year
#   - PUT  /anlage-aus/settings persists entries
#   - Per-entry math:
#     - hasDba=true (CH dividend, KapG): 5% taxable per § 8b KStG
#     - hasDba=true (FR interest, KapG): 0% taxable
#     - hasDba=false (US dividend): 100% taxable (Anrechnung)
#   - Per-country aggregation
#   - Progressionsvorbehalt sum (DBA-exempt portion)
#   - BMF Vordruck Kz lines (5, 6, 13, 20, 32, 34, 40, 42)
#   - PDF endpoint
#   - Berater packager auto-includes Anlage AUS
#   - Validation: bad year → 400, no user-id → 401
#   - Feature flag anlageAus forces inclusion

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Tier 361: the § 8b KStG assertions need the company to be a
# Kapitalgesellschaft. anlage-aus.service.ts reads settings.rechtsform and
# falls back to legalName, testing /^(GmbH|AG|KGaA|UG)/ — anchored at the
# start, so "SH Leder GmbH" is not recognised. The developer database had
# settings.rechtsform set; the CI seed does not, so every § 8b figure came
# out as for a non-KapG the first time this spec ran. Set it explicitly for
# the run and put the original back on exit. (The anchored fallback is
# recorded in HANDOFF as an open product question.)
T110_ORIG_RF=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT coalesce(settings->>'rechtsform', '') FROM \"Company\" WHERE id='$COMPANY_ID';" 2>/dev/null | tr -d '\n')
t110_restore_rechtsform() {
  if [ -n "$T110_ORIG_RF" ]; then
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
      "UPDATE \"Company\" SET settings = jsonb_set(settings, '{rechtsform}', to_jsonb('${T110_ORIG_RF}'::text)) WHERE id='$COMPANY_ID';" >/dev/null 2>&1
  else
    docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
      "UPDATE \"Company\" SET settings = settings - 'rechtsform' WHERE id='$COMPANY_ID';" >/dev/null 2>&1
  fi
}
trap t110_restore_rechtsform EXIT
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "UPDATE \"Company\" SET settings = coalesce(settings, '{}'::jsonb) || '{\"rechtsform\": \"GmbH\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null

TS=$(date +%s)
YEAR=$((2025 + (TS % 3)))  # 2025/2026/2027
PREFIX="Tier110-$TS"

note "=== Test prefix: $PREFIX / year: $YEAR ==="

# ===== 0. Clean up any prior data for $YEAR =====
echo
note "=== 0. Clean prior $YEAR data ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{\"year\": $YEAR, \"entries\": []}"
CLEAN_OK=$(json_field "$BODY" "ok")
assert_eq "cleanup: ok = True" "$CLEAN_OK" "True"

# ===== 1. GET /anlage-aus returns empty for a fresh year =====
echo
note "=== 1. GET /anlage-aus (empty) ==="
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
assert_status "200" "GET /anlage-aus empty"
EMPTY_COUNTS=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d['counts']['hasEntries']).lower(), str(d['counts']['countryCount']))")
HAS_ENT=$(echo "$EMPTY_COUNTS" | cut -d' ' -f1)
CCOUNT=$(echo "$EMPTY_COUNTS" | cut -d' ' -f2)
assert_eq "empty: hasEntries = false" "$HAS_ENT" "false"
assert_eq "empty: countryCount = 0" "$CCOUNT" "0"

# ===== 2. Rechtsform detected (KapG = § 8b KStG applicable) =====
echo
note "=== 2. rechtsform detected ==="
RECHTSFORM=$(json_field "$BODY" "rechtsform")
IS_KAPG=$(json_field "$BODY" "isKapg")
# The test company (SH Leder GmbH) is KapG, so isKapg=true
# Tier 361: this passed in both branches, so a non-KapG company went
# unnoticed and the § 8b assertions failed further down instead.
[[ "$IS_KAPG" = "True" || "$IS_KAPG" = "true" ]] && pass "isKapg = true (rechtsform=$RECHTSFORM)" || fail "isKapg = $IS_KAPG (rechtsform=$RECHTSFORM), expected true"

# ===== 3. PUT 1 entry: US, no DBA, dividend =====
echo
note "=== 3. PUT: 1 entry (US, no DBA, dividend, 5000) ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"entries\": [
      {
        \"country\": \"US\",
        \"countryName\": \"USA\",
        \"hasDba\": false,
        \"incomeType\": \"dividend\",
        \"grossAmount\": 5000,
        \"foreignTaxPaid\": 750,
        \"description\": \"AAPL 100 shares\"
      }
    ]
  }"
assert_status "200" "PUT /anlage-aus/settings"
SAVED_OK=$(json_field "$BODY" "ok")
assert_eq "save: ok = True" "$SAVED_OK" "True"

# ===== 4. Math: no-DBA entry → 100% taxable, 0% § 8b =====
echo
note "=== 4. Math: no-DBA entry → 100% taxable ==="
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
assert_status "200" "GET /anlage-aus after save"
GROSS_T=$(json_field "$BODY" "totals.grossTotal")
TAXABLE_T=$(json_field "$BODY" "totals.taxable")
PROG_T=$(json_field "$BODY" "totals.progressionsvorbehalt")
PARA8B=$(json_field "$BODY" "totals.paragraph8b")
ANRECH=$(json_field "$BODY" "totals.anrechnungsbetrag")
assert_close "grossTotal = 5000" "$GROSS_T" "5000"
assert_close "taxable = 5000 (no DBA)" "$TAXABLE_T" "5000"
assert_close "progressionsvorbehalt = 0" "$PROG_T" "0"
assert_close "paragraph8b = 0 (not § 8b since hasDba=false)" "$PARA8B" "0"
assert_close "anrechnungsbetrag = 750" "$ANRECH" "750"

# ===== 5. Per-country: US has 1 row, 5000, 100% taxable =====
echo
note "=== 5. Per-country: US ==="
US_PC=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
us = [c for c in d['perCountry'] if c['country']=='US']
if not us: print('none')
else:
  c = us[0]
  print(f'{c[\"count\"]}|{c[\"grossTotal\"]}|{c[\"taxablePortion\"]}|{c[\"exemptPortion\"]}|{c[\"hasDba\"]}')
")
US_COUNT=$(echo "$US_PC" | cut -d'|' -f1)
US_GROSS=$(echo "$US_PC" | cut -d'|' -f2)
US_TAX=$(echo "$US_PC" | cut -d'|' -f3)
US_EXEMPT=$(echo "$US_PC" | cut -d'|' -f4)
US_DBA=$(echo "$US_PC" | cut -d'|' -f5)
assert_eq "US count = 1" "$US_COUNT" "1"
assert_close "US grossTotal = 5000" "$US_GROSS" "5000"
assert_close "US taxable = 5000" "$US_TAX" "5000"
assert_close "US exempt = 0" "$US_EXEMPT" "0"
assert_eq "US hasDba = false" "$US_DBA" "False"

# ===== 6. PUT: CH (DBA) dividend (KapG) → § 8b KStG: 5% taxable =====
echo
note "=== 6. PUT: CH (DBA) dividend 10000 → § 8b 5% = 500 ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"entries\": [
      {
        \"country\": \"CH\",
        \"countryName\": \"Schweiz\",
        \"hasDba\": true,
        \"incomeType\": \"dividend\",
        \"grossAmount\": 10000,
        \"foreignTaxPaid\": 1500,
        \"description\": \"Nestlé 50 shares\"
      }
    ]
  }"
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
PARA8B_2=$(json_field "$BODY" "totals.paragraph8b")
PROG_2=$(json_field "$BODY" "totals.progressionsvorbehalt")
TAX_2=$(json_field "$BODY" "totals.taxable")
assert_close "paragraph8b = 500 (5% of 10000)" "$PARA8B_2" "500"
assert_close "progressionsvorbehalt = 9500 (DBA-exempt 95%)" "$PROG_2" "9500"
assert_close "taxable = 0 (5% is not 'Anrechnung taxable')" "$TAX_2" "0"

# ===== 7. Mixed: 3 entries across 2 countries =====
echo
note "=== 7. Mixed: CH dividend (DBA) + FR interest (DBA) + US dividend (no DBA) ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"entries\": [
      {
        \"country\": \"CH\",
        \"countryName\": \"Schweiz\",
        \"hasDba\": true,
        \"incomeType\": \"dividend\",
        \"grossAmount\": 10000,
        \"foreignTaxPaid\": 1500,
        \"description\": \"Nestlé\"
      },
      {
        \"country\": \"FR\",
        \"countryName\": \"Frankreich\",
        \"hasDba\": true,
        \"incomeType\": \"interest\",
        \"grossAmount\": 3000,
        \"foreignTaxPaid\": 750,
        \"description\": \"Bond\"
      },
      {
        \"country\": \"US\",
        \"countryName\": \"USA\",
        \"hasDba\": false,
        \"incomeType\": \"dividend\",
        \"grossAmount\": 5000,
        \"foreignTaxPaid\": 750,
        \"description\": \"AAPL\"
      }
    ]
  }"
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
assert_status "200" "GET /anlage-aus mixed"
GROSS_3=$(json_field "$BODY" "totals.grossTotal")
PROG_3=$(json_field "$BODY" "totals.progressionsvorbehalt")
TAX_3=$(json_field "$BODY" "totals.taxable")
PARA8B_3=$(json_field "$BODY" "totals.paragraph8b")
ANRECH_3=$(json_field "$BODY" "totals.anrechnungsbetrag")
assert_close "grossTotal = 18000 (10000+3000+5000)" "$GROSS_3" "18000"
# Progression = 9500 (CH div 95% exempt) + 3000 (FR interest 100% DBA) = 12500
assert_close "progressionsvorbehalt = 12500" "$PROG_3" "12500"
# Taxable = 0 (CH is § 8b 5% separately) + 0 (FR is fully DBA) + 5000 (US no-DBA)
assert_close "taxable = 5000" "$TAX_3" "5000"
assert_close "paragraph8b = 500" "$PARA8B_3" "500"
# Anrechnungsbetrag = 750 (US only; CH+FR are DBA, no Anrechnung)
assert_close "anrechnungsbetrag = 750" "$ANRECH_3" "750"

# ===== 8. BMF Vordruck Kz lines are present =====
echo
note "=== 8. BMF Vordruck Kz lines ==="
KZS=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(','.join(l['kennziffer'] for l in d['lines']))
")
for kz in 5 6 13 20 32 34 40 42; do
  HAS=$(echo "$KZS" | python3 -c "import sys; s=sys.stdin.read(); print('1' if '$kz' in s else '0')")
  test "$HAS" = "1" && pass "Kz $kz present in lines" || fail "Kz $kz missing from lines"
done

# ===== 9. Kz 5 (Progression) = 12500, Kz 6 (Taxable) = 5000 =====
echo
note "=== 9. Kz values ==="
K5=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='5'][0])")
K6=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='6'][0])")
K13=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='13'][0])")
K20=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='20'][0])")
K32=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='32'][0])")
K34=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['amount'] for l in d['lines'] if l['kennziffer']=='34'][0])")
assert_close "Kz 5 (Progression) = 12500" "$K5" "12500"
assert_close "Kz 6 (Taxable) = 5000" "$K6" "5000"
assert_close "Kz 13 (Anrechnung) = 750" "$K13" "750"
assert_close "Kz 20 (§ 8b Pauschale) = 500" "$K20" "500"
assert_close "Kz 32 (Dividends) = 15000" "$K32" "15000"
assert_close "Kz 34 (Interest) = 3000" "$K34" "3000"

# ===== 10. PDF endpoint returns valid PDF =====
echo
note "=== 10. PDF endpoint ==="
PDF_HEAD=$(curl -sS -o /tmp/anlage-aus-$TS.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-aus.pdf?companyId=$COMPANY_ID&year=$YEAR")
PDF_STATUS=$(echo "$PDF_HEAD" | cut -d'|' -f1)
PDF_CTYPE=$(echo "$PDF_HEAD" | cut -d'|' -f2)
PDF_SIZE=$(echo "$PDF_HEAD" | cut -d'|' -f3)
assert_eq "PDF status 200" "$PDF_STATUS" "200"
assert_eq "PDF content-type" "$PDF_CTYPE" "application/pdf"
test "$PDF_SIZE" -gt 1500 && pass "PDF size = $PDF_SIZE bytes" || fail "PDF too small: $PDF_SIZE"
file /tmp/anlage-aus-$TS.pdf | grep -q "PDF document" && pass "magic bytes = PDF" || fail "not a PDF"

# ===== 11. PDF Content-Disposition: attachment =====
echo
note "=== 11. PDF Content-Disposition ==="
HEAD_FILE=/tmp/anlage-aus-headers-$TS.txt
curl -sS -o /dev/null -D "$HEAD_FILE" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-aus.pdf?companyId=$COMPANY_ID&year=$YEAR" >/dev/null
DISP=$(grep -i '^content-disposition:' "$HEAD_FILE" 2>&1 | head -1 || echo "")
[[ "$DISP" == *"attachment"* ]] && pass "Content-Disposition = attachment" || fail "no attachment header: $DISP"
FNAME=$(echo "$DISP" | grep -oE 'filename="[^"]+"' | sed 's/^filename="//;s/"$//' || echo "")
assert_eq "filename matches" "$FNAME" "Anlage-AUS-$YEAR.pdf"

# ===== 12. Bad year → 400 =====
echo
note "=== 12. Bad year → 400 ==="
BAD_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=1999")
test "$BAD_STATUS" = "400" && pass "year=1999 → 400" || fail "year=1999 → $BAD_STATUS (expected 400)"

# ===== 13. Cross-tenant: no x-user-id → 401 =====
echo
note "=== 13. Cross-tenant: no x-user-id → 401 ==="
NO_AUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR")
test "$NO_AUTH_STATUS" = "401" && pass "no x-user-id → 401" || fail "no x-user-id → $NO_AUTH_STATUS (expected 401)"

# ===== 14. PUT roundtrip preserves all fields =====
echo
note "=== 14. PUT → GET roundtrip ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"entries\": [
      {
        \"country\": \"UK\",
        \"countryName\": \"Vereinigtes Königreich\",
        \"hasDba\": true,
        \"incomeType\": \"rental\",
        \"grossAmount\": 12000,
        \"foreignTaxPaid\": 2000,
        \"description\": \"London flat\"
      }
    ]
  }"
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
ENTRY_DESC=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['entries'][0]['description'] if d['entries'] else 'none')")
ENTRY_COUNTRY=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['entries'][0]['country'] if d['entries'] else 'none')")
assert_eq "roundtrip: tx description" "$ENTRY_DESC" "London flat"
assert_eq "roundtrip: country" "$ENTRY_COUNTRY" "UK"

# ===== 15. Berater packager auto-includes Anlage AUS =====
echo
note "=== 15. Berater packager auto-includes Anlage AUS ==="
PACK_FILE=/tmp/berater-aus-$TS.zip
PACK_STATUS=$(curl -sS -o "$PACK_FILE" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=$YEAR")
test "$PACK_STATUS" = "200" && pass "berater packager 200" || fail "berater packager → $PACK_STATUS"
# Anlage-AUS.pdf may be in the packager
if [ -s "$PACK_FILE" ] && unzip -l "$PACK_FILE" 2>/dev/null | grep "Anlage-AUS.pdf" >/dev/null; then
  pass "Anlage-AUS.pdf in packager"
else
  fail "Anlage-AUS.pdf missing from packager"
fi

# ===== 16. Feature flag anlageAus forces inclusion for empty year =====
echo
note "=== 16. Feature flag anlageAus forces inclusion ==="
FEAT_YEAR=$((YEAR + 1))
api_patch "/api/v1/companies/$COMPANY_ID/feature-flags" \
  "{\"anlageAus\": true}"
PATCH_OK=$(json_field "$BODY" "anlageAus")
assert_eq "feature flag: anlageAus = True" "$PATCH_OK" "True"
PACK2_FILE=/tmp/berater-aus2-$TS.zip
curl -sS -o "$PACK2_FILE" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/berater-packager?companyId=$COMPANY_ID&year=$FEAT_YEAR" >/dev/null
if [ -s "$PACK2_FILE" ] && unzip -l "$PACK2_FILE" 2>/dev/null | grep "Anlage-AUS.pdf" >/dev/null; then
  pass "flag-forced Anlage-AUS.pdf in packager for $FEAT_YEAR"
else
  fail "flag-forced Anlage-AUS.pdf missing"
fi
# Reset flag
api_patch "/api/v1/companies/$COMPANY_ID/feature-flags" \
  "{\"anlageAus\": false}"
PATCH_OK2=$(json_field "$BODY" "anlageAus")
assert_eq "feature flag reset: anlageAus = False" "$PATCH_OK2" "False"

# ===== 17. countryCount matches the number of unique countries =====
echo
note "=== 17. countryCount ==="
api_put "/api/v1/accounting/anlage-aus/settings?companyId=$COMPANY_ID" \
  "{
    \"year\": $YEAR,
    \"entries\": [
      {\"country\": \"US\", \"countryName\": \"USA\", \"hasDba\": false, \"incomeType\": \"dividend\", \"grossAmount\": 1000, \"foreignTaxPaid\": 100, \"description\": \"x1\"},
      {\"country\": \"US\", \"countryName\": \"USA\", \"hasDba\": false, \"incomeType\": \"interest\", \"grossAmount\": 2000, \"foreignTaxPaid\": 200, \"description\": \"x2\"},
      {\"country\": \"CA\", \"countryName\": \"Kanada\", \"hasDba\": true, \"incomeType\": \"dividend\", \"grossAmount\": 500, \"foreignTaxPaid\": 50, \"description\": \"y1\"}
    ]
  }"
api_get "/api/v1/accounting/anlage-aus?companyId=$COMPANY_ID&year=$YEAR"
CCOUNT_2=$(json_field "$BODY" "counts.countryCount")
# 2 unique countries (US + CA) even with 3 entries
assert_eq "countryCount = 2 (US + CA)" "$CCOUNT_2" "2"

# ===== 18. § 8b KStG only for KapG (rechtsform starts with GmbH/AG/KGaA/UG) =====
echo
note "=== 18. § 8b KStG only for KapG ==="
# Test isKapg=true was confirmed in section 2; verify
# § 8b actually applies.
PARA8B_4=$(json_field "$BODY" "totals.paragraph8b")
# CA (DBA) dividend 500 → 5% of 500 = 25
assert_close "paragraph8b = 25 (5% of CA 500)" "$PARA8B_4" "25"

# ===== 19. Missing companyId → 400 =====
echo
note "=== 19. Missing companyId → 400 ==="
NO_COMPANY_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"year\": $YEAR, \"entries\": []}" \
  "$API/api/v1/accounting/anlage-aus/settings")
test "$NO_COMPANY_STATUS" = "400" && pass "no companyId → 400" || fail "no companyId → $NO_COMPANY_STATUS (expected 400)"

summary "Tier 110 — Anlage AUS (Ausländische Einkünfte)"
