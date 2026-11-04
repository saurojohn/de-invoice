#!/bin/bash
# Tier 795 — settings saved at the same time are all kept; saving the bank
# details keeps the dunning fees
#
# Company.settings is one JSON column for the DATEV numbers, the Anlage flags,
# the Hebesatz, the prepayments, the dunning stages, the time rounding… Each
# writer read the column, changed its key and wrote all of it back: two saves
# at once (two tabs, two people) and the later one undid the other. Measured
# on the code before: 15 of 15 pairs of the feature flags and the DATEV
# settings lost one. Now each writer reads and writes under the company's row
# lock (common/company-settings.ts).
#
# Company.bankInfo holds the Mahngebühren and the Verzugszins next to the
# IBAN; the settings page sends bank name, IBAN and BIC, and a save dropped
# the fees (measured). The keys sent are merged over the stored ones now.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-497-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
B="{\"email\":\"$TAG@example.test\",\"password\":\"Tier795-e2e\",\"companyName\":\"$TAG GmbH\"}"
curl -sS -o "$D/reg" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$B"
U=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['id'])"); C=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['companyId'])")
H=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
send() { # method path body → status into $D/st.<n>
  curl -sS -o /dev/null -w '%{http_code}' -X "$1" "$API$2" "${H[@]}" -d "$3"
}

note "=== six settings saved at the same time, ten times ==="
FLAGS='{"anlageV":true}'
DATEV='{"beraterNr":"12345","mandantenNr":"678"}'
GEWST='{"year":2026,"q1":100,"q2":100,"q3":100,"q4":100,"hebesatz":450}'
ROUND='{"rounding":{"minutes":15,"mode":"up"}}'
DUNN='{"level1Days":14,"level2Days":28,"level3Days":42,"level1Fee":0,"level2Fee":5,"level3Fee":10}'
KST='{"year":2026,"q1":200,"q2":200,"q3":200,"q4":200}'
lost=0; bad=0
for i in $(seq 1 10); do
  q "update \"Company\" set settings='{}' where id='$C'" >/dev/null
  send PATCH "/api/v1/companies/$C/feature-flags" "$FLAGS" > "$D/st.1" &
  send PUT "/api/v1/companies/$C/datev-config" "$DATEV" > "$D/st.2" &
  send PUT "/api/v1/accounting/gewst/settings?companyId=$C" "$GEWST" > "$D/st.3" &
  send PUT "/api/v1/time-entries/settings?companyId=$C" "$ROUND" > "$D/st.4" &
  send PUT "/api/v1/reminders/dunning-config?companyId=$C" "$DUNN" > "$D/st.5" &
  send PUT "/api/v1/accounting/kst1/vorauszahlungen?companyId=$C" "$KST" > "$D/st.6" &
  wait
  [ "$(cat "$D"/st.* | tr -d '\n')" = "200200200200200200" ] || bad=$((bad + 1))
  got=$(q "select concat_ws('/', settings->>'anlageV', settings->'datev'->>'beraterNr', settings->>'hebesatz', settings->'timeRounding'->>'minutes', settings->'dunning'->>'level1Days', settings->'kstVorauszahlungen'->'2026'->>'q1') from \"Company\" where id='$C'")
  [ "$got" = "true/12345/450/15/14/200" ] || { lost=$((lost + 1)); note "round $i: $got"; }
done
assert_eq "every save answered 200" "$bad" "0"
assert_eq "rounds in which a save was lost (was 10 of 10)" "$lost" "0"

note "=== the settings page's bank details keep the dunning fees ==="
B='{"verzugszinsPct":12,"mahngebuehr":{"first":5,"second":10,"final":15}}'
assert_eq "the fees are set" "$(send PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" "$B")" "200"
B="{\"name\":\"$TAG GmbH\",\"bankInfo\":{\"bankName\":\"Sparkasse\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "the settings page saves the bank details" "$(send PUT "/api/v1/companies/$C" "$B")" "200"
assert_eq "…the IBAN is saved" "$(q "select \"bankInfo\"->>'iban' from \"Company\" where id='$C'")" "DE89370400440532013000"
assert_eq "…the Mahngebühr of the final reminder is kept (was gone)" "$(q "select \"bankInfo\"->'mahnungConfig'->'mahngebuehr'->>'final' from \"Company\" where id='$C'")" "15"
assert_eq "…and the Verzugszins (was gone)" "$(q "select \"bankInfo\"->'mahnungConfig'->>'verzugszinsPct' from \"Company\" where id='$C'")" "12"
B="{\"name\":\"$TAG GmbH\",\"bankInfo\":{\"bankName\":\"Sparkasse\",\"iban\":\"\",\"bic\":\"\"}}"
assert_eq "an IBAN emptied on the page is emptied" "$(send PUT "/api/v1/companies/$C" "$B")/$(q "select \"bankInfo\"->>'iban' from \"Company\" where id='$C'")" "200/"

summary
