#!/bin/bash
# Tier 527 — what every invoice prints can be what it claims to be
#
# Measured before, on the company's master data: the IBAN took "DE00 1234"
# and a German IBAN with a wrong check digit (it is printed on every invoice,
# goes into the GiroCode, the XRechnung payment means and the SEPA files);
# the Steuernummer took "abc" (§ 14 Abs. 4 Nr. 2 UStG); the name took "   ".
# A supplier's IBAN — where the SEPA transfer goes — took a wrong check digit.
#
# Now: MOD 97-10 on the IBAN (22 characters for a German one), 10–13 digits
# for the Steuernummer, a name that is not blank. Empty values stay allowed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-312-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier527-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
put() { AS PUT "/api/v1/companies/$C" "$1"; }
col() { q "select coalesce($1,'') from \"Company\" where id='$C'"; }

note "=== the company's IBAN ==="
put '{"bankInfo":{"iban":"DE00 1234","bic":"X"}}'
assert_eq "DE00 1234: 400 (was 200)" "$STATUS" "400"
put '{"bankInfo":{"iban":"DE89370400440532013001"}}'
assert_eq "a wrong check digit: 400 (was 200)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Prüfziffer' in d['message']")" "True"
put '{"bankInfo":{"iban":"DE8937040044053201300"}}'
assert_eq "21 characters: 400" "$STATUS" "400"
assert_eq "…nothing stored" "$(col "\"bankInfo\"->>'iban'")" ""
put '{"bankInfo":{"iban":"DE89 3704 0044 0532 0130 00","bic":"COBADEFFXXX"}}'
assert_eq "a valid one, with spaces: stored" "$STATUS/$(col "\"bankInfo\"->>'iban'")" "200/DE89 3704 0044 0532 0130 00"
put '{"bankInfo":{"iban":"AT611904300234573201"}}'
assert_eq "an Austrian one: stored" "$STATUS" "200"
put '{"bankInfo":{"iban":"","bic":""}}'
assert_eq "emptied: fine" "$STATUS" "200"

note "=== the Steuernummer and the name ==="
put '{"taxId":"abc"}'
assert_eq "Steuernummer abc: 400 (was 200)" "$STATUS" "400"
put '{"taxId":"12/345"}'
assert_eq "five digits: 400" "$STATUS" "400"
put '{"taxId":"12/345/67890"}'
assert_eq "12/345/67890: stored" "$STATUS/$(col '"taxId"')" "200/12/345/67890"
put '{"taxId":"2893081508152"}'
assert_eq "the 13-digit ELSTER form: stored" "$STATUS" "200"
put '{"name":"   "}'
assert_eq "a blank name: 400 (was 200)" "$STATUS" "400"
put '{"name":""}'
assert_eq "an empty name: 400 (was 200)" "$STATUS" "400"
assert_eq "…the name is as it was" "$(col 'name')" "$TAG GmbH"
put "{\"name\":\"  $TAG AG  \"}"
assert_eq "a name with spaces around it: trimmed" "$STATUS/$(col 'name')" "200/$TAG AG"
put '{"phone":"030 1234"}'
assert_eq "an edit of something else: fine" "$STATUS" "200"

note "=== a supplier's IBAN ==="
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"bankInfo\":{\"iban\":\"DE89370400440532013001\"}}"
assert_eq "a wrong check digit: 400 (was 201)" "$STATUS" "400"
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"bankInfo\":{\"iban\":\"DE89370400440532013000\"}}"
assert_eq "a valid one: created" "$STATUS" "201"
SU=$(json_field "$BODY" id)
AS PUT "/api/v1/suppliers/$SU?companyId=$C" '{"bankInfo":{"iban":"DE89370400440532013999"}}'
assert_eq "edited to a wrong one: 400 (was 200)" "$STATUS" "400"
assert_eq "…it keeps its IBAN" "$(q "select \"bankInfo\"->>'iban' from \"Supplier\" where id='$SU'")" "DE89370400440532013000"
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG ohne Bank\"}"
assert_eq "a supplier without bank details: created" "$STATUS" "201"

summary
