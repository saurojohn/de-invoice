#!/bin/bash
# Test 26: Tier 5.5 — DATEV-config UI roundtrip
#
# Verifies that the per-company DATEV config endpoint
# round-trips the Tier 5 fields the frontend now edits:
#   - 13 SKR03 account overrides
#   - Berater-Nr + Mandanten-Nr
#   - openingBalances (array of {konto, betrag, shVz, buchungstext})
#   - laufNr (per-year counter map)
#
# The UI itself is not exercised here (Next.js pages
# can't be hit cleanly from a shell). We exercise the
# same endpoints the UI uses, since the roundtrip
# contract is the integration surface. Test 07 already
# covers the SKR03 account / Berater-Nr / Mandanten-Nr
# path; this test focuses on the Tier 5 additions.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5.5 DATEV-config roundtrip ==="

# ----- Reset to clean state -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1

# ===== Defaults roundtrip: GET returns the SKR03_DEFAULTS =====
api_get "/api/v1/companies/$COMPANY_ID/datev-config"
assert_eq "default config.bank"  "$(json_field "$BODY" config.bank)"  "1200"
assert_eq "default config.revenue19"  "$(json_field "$BODY" config.revenue19)"  "8400"
# Tier 423: SKR03 Vorsteuer aus igE 19 % is 1574 (1782 is an
# Umsatzsteuer-Vorauszahlung account).
assert_eq "default config.inputVatIgE = 1574"  "$(json_field "$BODY" config.inputVatIgE)"  "1574"
# openingBalances + laufNr are present (even if empty)
assert_eq "default openingBalances empty"  "$(json_field "$BODY" openingBalances)" "[]"
assert_eq "default laufNr empty"  "$(json_field "$BODY" laufNr)"  "{}"

# ===== PUT openingBalances + laufNr + a custom account =====
# Verify the request body the UI sends: accounts as
# a sparse object, openingBalances as an array,
# laufNr as a year→number map.
api_put "/api/v1/companies/$COMPANY_ID/datev-config" '{
  "accounts": { "bank": "9999" },
  "beraterNr": "12345",
  "mandantenNr": "67890",
  "openingBalances": [
    { "konto": "1200", "betrag": 5000, "shVz": "S", "buchungstext": "EB Bank" },
    { "konto": "1400", "betrag": 2500, "shVz": "S", "buchungstext": "EB Forderungen" }
  ],
  "laufNr": { "2026": 3 }
}'
assert_status "200" "PUT with openingBalances + laufNr"

# GET back: verify each piece round-tripped
api_get "/api/v1/companies/$COMPANY_ID/datev-config"
# Config merge: custom bank 9999 + default revenue19 8400
assert_eq "custom bank 9999 in config" \
  "$(json_field "$BODY" config.bank)" "9999"
assert_eq "default revenue19 still 8400" \
  "$(json_field "$BODY" config.revenue19)" "8400"
# Berater + Mandanten survive the roundtrip
assert_eq "beraterNr = 12345" \
  "$(json_field "$BODY" config.beraterNr)" "12345"
assert_eq "mandantenNr = 67890" \
  "$(json_field "$BODY" config.mandantenNr)" "67890"
# Overrides: bank 9999
assert_eq "overrides.bank = 9999" \
  "$(json_field "$BODY" overrides.bank)" "9999"
# openingBalances: 2 entries, correct shape
OB_LEN=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(len(d['openingBalances']))
")
assert_eq "openingBalances length" "$OB_LEN" "2"
OB_FIRST_KONTO=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['openingBalances'][0]['konto'])
")
assert_eq "openingBalances[0].konto" "$OB_FIRST_KONTO" "1200"
OB_FIRST_BETRAG=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['openingBalances'][0]['betrag'])
")
assert_eq "openingBalances[0].betrag" "$OB_FIRST_BETRAG" "5000"
# laufNr: 2026 = 3
LAUF=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['laufNr'].get('2026', ''))
")
assert_eq "laufNr.2026 = 3" "$LAUF" "3"

# ===== Sanitisation: invalid openingBalances are dropped =====
# Each row has exactly one defect; all 4 should be
# dropped on the PUT. The valid row (5th) survives.
api_put "/api/v1/companies/$COMPANY_ID/datev-config" '{
  "openingBalances": [
    { "konto": "AB-CD", "betrag": 1000, "shVz": "S", "buchungstext": "bad konto" },
    { "konto": "1200", "betrag": 0,    "shVz": "S", "buchungstext": "zero betrag" },
    { "konto": "1200", "betrag": 100,  "shVz": "X", "buchungstext": "bad shVz" },
    { "konto": "1200", "betrag": -1,   "shVz": "S", "buchungstext": "negative betrag" },
    { "konto": "1200", "betrag": 100,  "shVz": "S", "buchungstext": "valid" }
  ]
}'
assert_status "200" "PUT with mixed-validity openingBalances"

api_get "/api/v1/companies/$COMPANY_ID/datev-config"
# 4 invalid dropped, 1 valid kept
OB_LEN=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(len(d['openingBalances']))
")
assert_eq "only 1 valid EB-Werte kept" "$OB_LEN" "1"
OB_TEXT=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['openingBalances'][0]['buchungstext'])
")
assert_eq "kept EB has buchungstext 'valid'" "$OB_TEXT" "valid"

# ===== Sanitisation: invalid laufNr keys/values =====
# (a) bad year format, (b) non-integer value — dropped
api_put "/api/v1/companies/$COMPANY_ID/datev-config" '{
  "laufNr": { "abc": 1, "2026": "notanumber", "2027": 5 }
}'
assert_status "200" "PUT with partial-bad laufNr"

api_get "/api/v1/companies/$COMPANY_ID/datev-config"
# Only 2027 should survive
LAUF_KEYS=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(','.join(sorted(d['laufNr'].keys())))
")
assert_eq "laufNr kept only valid 2027" "$LAUF_KEYS" "2027"
LAUF_2027=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['laufNr'].get('2027', ''))
")
assert_eq "laufNr.2027 = 5" "$LAUF_2027" "5"

# ===== UI's typical flow: partial PUT keeps existing data =====
# Reset to a known good state
api_put "/api/v1/companies/$COMPANY_ID/datev-config" '{
  "accounts": { "bank": "9999" },
  "beraterNr": "12345",
  "openingBalances": [
    { "konto": "1200", "betrag": 1000, "shVz": "S", "buchungstext": "Keep" }
  ],
  "laufNr": { "2026": 7 }
}'
assert_status "200" "PUT seed"

# Now PUT ONLY accounts — openingBalances and laufNr
# are NOT in the body. The endpoint should leave them
# untouched (the existing state.datev values persist).
api_put "/api/v1/companies/$COMPANY_ID/datev-config" '{
  "accounts": { "bank": "1111" }
}'
assert_status "200" "PUT accounts only (no EB)"

api_get "/api/v1/companies/$COMPANY_ID/datev-config"
assert_eq "bank updated to 1111" \
  "$(json_field "$BODY" config.bank)" "1111"
# EB still there
OB_LEN=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(len(d['openingBalances']))
")
assert_eq "EB preserved when not in body" "$OB_LEN" "1"
# laufNr still there
LAUF_2026=$(python3 -c "
import json, sys
d = json.loads('''$BODY''')
print(d['laufNr'].get('2026', ''))
")
assert_eq "laufNr.2026 preserved" "$LAUF_2026" "7"

# ===== datev-export actually uses the new settings =====
# The export endpoint reads laufNr from settings.datev
# and prints "Lauf NNN" in header field 5. This
# confirms the roundtrip path is wired end-to-end.
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -D /tmp/datev-roundtrip-hdr.txt -o /tmp/datev-roundtrip.csv
LAUF_HDR=$(python3 -c "
import sys
with open('/tmp/datev-roundtrip.csv', 'rb') as f:
    line = f.readline().decode('cp1252').rstrip()
print(line.split(';')[30].strip('\"'))
")
# Tier 423: DATEV header field 31 (Anwendungsinformation); field 5 is the
# format version.
assert_eq "export header field 31 = laufNr 7" "$LAUF_HDR" "Lauf 007"

# Filename has the same laufNr (L007)
if LC_ALL=C grep -qi 'filename="EXTF_Buchungsstapel_2026-01-01_L007.csv"' /tmp/datev-roundtrip-hdr.txt; then
  pass "filename uses laufNr 7: L007.csv"
else
  fail "filename missing L007"
  grep -i "filename" /tmp/datev-roundtrip-hdr.txt | head -1
fi

# EB-Werte line uses the roundtripped openingBalances
# ("Keep" was the only EB saved above).
if LC_ALL=C grep -q "EB Bank" /tmp/datev-roundtrip.csv; then
  fail "old EB-Werte leaked: EB Bank still in export"
else
  pass "old EB-Werte (EB Bank) replaced by new (Keep)"
fi
if LC_ALL=C grep -q ';"Keep"' /tmp/datev-roundtrip.csv; then
  pass "new EB-Werte (Keep) present in export"
else
  fail "new EB-Werte (Keep) missing from export"
fi

# ----- Cleanup -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
