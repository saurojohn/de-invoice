#!/bin/bash
# Tier 382 — tax-form settings reject bad figures instead of storing 0
#
# PUT /accounting/{anlage-n,anlage-r,anlage-kind,anlage-so,anlage-aus,gewst}/settings
# coerced their inline-typed bodies. Measured before the change, all 200:
#   N    lohnsteuer "zehn" → stored 0; lohnsteuer -500 → stored -500;
#        werbungskosten with a string, a nested object and an HTML key → stored
#        verbatim; 20000 keys → Company.settings 298 KB
#   R    drv "zehn", bav -5 → stored 0
#   Kind 5000-char name, birthDate "2026-02-30" → stored
#   SO   acquisitionCost "zehn" → 0; salePrice -100, saleDate "2031-13-01" → stored
#   AUS  country "XXXX" → "XX"; incomeType "bogus" → "other"; grossAmount "abc" → 0;
#        foreignTaxPaid -3 → stored
#   GewSt q1 -100, q2 "zehn" → 0
# Uses year 2033 so it never touches the years the other Anlage specs use.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
Y=2033
Q="companyId=$COMPANY_ID"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
stored() { sql "SELECT coalesce((settings::jsonb #> '{$1}')::text, 'null') FROM \"Company\" WHERE id = '$COMPANY_ID';"; }
put() { api_put "/api/v1/accounting/$1?$Q" "$2"; }

note "=== 1. the sections' request shapes still work ==="
# AnlageNSection.save: eight numbers + werbungskosten by Kennziffer
put anlage-n/settings "{\"year\":$Y,\"bruttoArbeitslohn\":60000,\"lohnsteuer\":10000,\"soli\":550,\"kirchensteuer\":900,\"rentenversicherung\":5616,\"arbeitslosenversicherung\":720,\"krankenversicherung\":4350,\"pflegeversicherung\":1100,\"werbungskosten\":{\"140\":1500,\"150\":0,\"160\":0,\"170\":800,\"180\":0,\"190\":0}}"
assert_status 200 "Anlage N: section shape"
assert_eq "…lohnsteuer stored" "$(stored "lohnsteuerbescheinigungen,$Y,lohnsteuer")" "10000"
# AnlageRSection.save
put anlage-r/settings "{\"year\":$Y,\"drv\":18000,\"bav\":6000,\"riester\":1200,\"ruerup\":0,\"privat\":2400,\"sonstige\":0,\"werbungskosten\":{\"200\":0,\"220\":0,\"230\":150}}"
assert_status 200 "Anlage R: section shape"
# AnlageKindSection.save: an empty date input is "" and still allowed
put anlage-kind/settings "{\"year\":$Y,\"kinder\":[{\"name\":\"Max\",\"birthDate\":\"2018-05-12\",\"kindergeldEligible\":true},{\"name\":\"\",\"birthDate\":\"\",\"kindergeldEligible\":false}]}"
assert_status 200 "Anlage Kind: section shape (incl. empty birthDate)"
# AnlageSOSection.save / e2e 135
put anlage-so/settings "{\"year\":$Y,\"transactions\":[{\"type\":\"wertpapier\",\"description\":\"BTC 0.1\",\"acquisitionDate\":\"2032-06-01\",\"acquisitionCost\":5000,\"saleDate\":\"$Y-03-15\",\"salePrice\":8000},{\"type\":\"sonstige\",\"description\":\"offen\",\"acquisitionDate\":\"\",\"acquisitionCost\":0,\"saleDate\":\"\",\"salePrice\":0}],\"wiederkehrendeBezuege\":0,\"werbungskosten\":0}"
assert_status 200 "Anlage SO: section shape (incl. empty dates)"
# AnlageAUSSection.save / e2e 136 (country "UK", not ISO)
put anlage-aus/settings "{\"year\":$Y,\"entries\":[{\"country\":\"UK\",\"countryName\":\"Vereinigtes Königreich\",\"hasDba\":true,\"incomeType\":\"rental\",\"grossAmount\":12000,\"foreignTaxPaid\":2000,\"description\":\"London flat\"},{\"country\":\"\",\"countryName\":\"\",\"hasDba\":false,\"incomeType\":\"dividend\",\"grossAmount\":0,\"foreignTaxPaid\":0,\"description\":\"draft row\"}]}"
assert_status 200 "Anlage AUS: section shape"
# GewstSection.save / e2e 132
put gewst/settings "{\"year\":$Y,\"q1\":1500,\"q2\":1500,\"q3\":1500,\"q4\":1500}"
assert_status 200 "GewSt: section shape"
put gewst/settings '{"q1":0,"q2":0,"q3":0,"q4":0}';       assert_status 400 "GewSt: missing year still 400"
put gewst/settings '{"year":1999,"q1":0}';                assert_status 400 "GewSt: year 1999 still 400"

note "=== 2. bad figures are 400 and the stored year is unchanged ==="
N_BEFORE=$(stored "lohnsteuerbescheinigungen,$Y")
put anlage-n/settings "{\"year\":$Y,\"lohnsteuer\":\"zehn\"}";   assert_status 400 "N: lohnsteuer \"zehn\" (was 200, stored 0)"
put anlage-n/settings "{\"year\":$Y,\"lohnsteuer\":-500}";       assert_status 400 "N: lohnsteuer -500 (was 200, stored)"
put anlage-n/settings "{\"year\":$Y,\"lohnsteuer\":null}";       assert_status 400 "N: lohnsteuer null (the client's NaN)"
put anlage-n/settings "{\"year\":$Y,\"werbungskosten\":{\"130\":\"abc\"}}";               assert_status 400 "N: werbungskosten value \"abc\" (was stored)"
put anlage-n/settings "{\"year\":$Y,\"werbungskosten\":{\"x\":{\"nested\":[1,2,3]}}}";    assert_status 400 "N: werbungskosten nested object (was stored)"
put anlage-n/settings "{\"year\":$Y,\"werbungskosten\":$(python3 -c 'import json;print(json.dumps({str(i):1 for i in range(1000,1031)}))')}"
assert_status 400 "N: werbungskosten with 31 keys (20000 were stored)"
assert_eq "N: stored year unchanged" "$(stored "lohnsteuerbescheinigungen,$Y")" "$N_BEFORE"
put anlage-r/settings "{\"year\":$Y,\"drv\":\"zehn\"}";          assert_status 400 "R: drv \"zehn\" (was 200, stored 0)"
put anlage-r/settings "{\"year\":$Y,\"bav\":-5}";                assert_status 400 "R: bav -5 (was 200, stored 0)"
put anlage-kind/settings "{\"year\":$Y,\"kinder\":[{\"name\":\"$(printf 'K%.0s' $(seq 1 150))\"}]}"; assert_status 400 "Kind: 150-char name (5000 were stored)"
put anlage-kind/settings "{\"year\":$Y,\"kinder\":[{\"name\":\"Max\",\"birthDate\":\"2026-02-30\"}]}"; assert_status 400 "Kind: birthDate 2026-02-30 (was stored)"
put anlage-so/settings "{\"year\":$Y,\"transactions\":[{\"description\":\"x\",\"acquisitionCost\":\"zehn\"}]}"; assert_status 400 "SO: acquisitionCost \"zehn\" (was 0)"
put anlage-so/settings "{\"year\":$Y,\"transactions\":[{\"description\":\"x\",\"salePrice\":-100}]}";        assert_status 400 "SO: salePrice -100 (was stored)"
put anlage-so/settings "{\"year\":$Y,\"transactions\":[{\"description\":\"x\",\"saleDate\":\"$Y-13-01\"}]}"; assert_status 400 "SO: saleDate month 13 (was stored)"
put anlage-aus/settings "{\"year\":$Y,\"entries\":[{\"country\":\"XXXX\"}]}";          assert_status 400 "AUS: country XXXX (was cut to XX)"
put anlage-aus/settings "{\"year\":$Y,\"entries\":[{\"incomeType\":\"bogus\"}]}";      assert_status 400 "AUS: incomeType bogus (was 'other')"
put anlage-aus/settings "{\"year\":$Y,\"entries\":[{\"grossAmount\":\"abc\"}]}";       assert_status 400 "AUS: grossAmount \"abc\" (was 0)"
put anlage-aus/settings "{\"year\":$Y,\"entries\":[{\"foreignTaxPaid\":-3}]}";         assert_status 400 "AUS: foreignTaxPaid -3 (was stored)"
G_BEFORE=$(stored "gewstVorauszahlungen,$Y")
put gewst/settings "{\"year\":$Y,\"q1\":-100}";                  assert_status 400 "GewSt: q1 -100 (was stored 0)"
put gewst/settings "{\"year\":$Y,\"q2\":\"zehn\"}";              assert_status 400 "GewSt: q2 \"zehn\" (was stored 0)"
assert_eq "GewSt: stored year unchanged" "$(stored "gewstVorauszahlungen,$Y")" "$G_BEFORE"

note "=== 3. cleanup ==="
for key in lohnsteuerbescheinigungen werbungskosten renten rentenWerbungskosten kinder anlageSO anlageAUS gewstVorauszahlungen; do
  sql "UPDATE \"Company\" SET settings = settings::jsonb #- '{$key,$Y}' WHERE id = '$COMPANY_ID';" >/dev/null
done
assert_eq "year $Y removed from the settings" "$(stored "gewstVorauszahlungen,$Y")" "null"

summary
exit $?
