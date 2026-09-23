#!/bin/bash
# Tier 434 — cash taken to the bank reaches DATEV
#
# Measured before: a Kassenbuch "Umbuchung" (cash to the bank, 300 €) was in
# no DATEV export — the Kasse account in the Berater's books stayed 300 € too
# high. It is booked Geldtransit 1360 an Kasse 1000 now; the bank side comes
# with the bank statement (Bank an Geldtransit).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-223-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); FROM=$(date +%Y-%m-01)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier434-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
entry() { AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$TODAY\",$1}"; json_field "$BODY" id; }
export_csv() { curl -sS -o /tmp/t434.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TODAY"; }

entry '"type":"eroeffnung","description":"Anfangsbestand","amount":500' >/dev/null
entry '"type":"einnahme","description":"Barverkauf","amount":595,"vatRate":0.19' >/dev/null
T=$(entry '"type":"umbuchung","description":"Umbuchung an Bank","amount":300,"belegNumber":"EZ-1"')
[[ -n "$T" ]] && pass "fixture: cash sale, then 300 € to the bank" || fail "entries"

export_csv
assert_eq "Kasse 1000 an Geldtransit 1360, 300,00 H (was: not exported)" \
  "$(datev_rows /tmp/t434.csv | awk -F'\t' '$1=="EZ-1" {print $3":"$4":"$5":"$6}')" "1000:1360:300.00:H"
assert_eq "Kasse in DATEV: +595 − 300" "$(datev_balance /tmp/t434.csv 1000)" "295.00"

AS POST "/api/v1/cashbook/entries/$T/reverse?companyId=$C" '{"reason":"falsch erfasst"}'
export_csv
assert_eq "a Storno of the transfer nets Geldtransit to 0" "$(datev_balance /tmp/t434.csv 1360)" "0.00"

summary; exit $?
