#!/bin/bash
# Tier 516 — the Kassenbuch and the Anlagenverzeichnis take no day in the future
#
# Tier 515 closed the dates of invoices, expenses and tax payments. Measured
# before, the Kassenbuch still booked a receipt on 02.01.2030 (§ 146 Abs. 1
# AO: cash receipts and payments are recorded daily — a day that has not come
# has no cash movement), closed a day in 2030, and the Anlagenverzeichnis
# took an asset acquired in 2030 and a sale in 2030.
#
# Now all four are refused (400).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-301-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier516-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")
entry() { AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$1\",\"type\":\"$2\",\"description\":\"$TAG\",\"amount\":$3}"; }

note "=== the Kassenbuch ==="
entry "2030-01-01" eroeffnung 100
assert_eq "an opening balance in 2030: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Zukunft' in d['message']")" "True"
entry "$TODAY" eroeffnung 100
assert_eq "today: booked" "$STATUS" "201"
entry "$TOMORROW" einnahme 50
assert_eq "a receipt tomorrow: 400 (was 201)" "$STATUS" "400"
entry "$TODAY" einnahme 50
assert_eq "a receipt today: booked" "$STATUS" "201"
assert_eq "…two entries, none in the future" "$(q "select count(*)||'/'||count(*) filter (where \"businessDate\" > current_date + 1) from \"CashBookEntry\" where \"companyId\"='$C'")" "2/0"
AS POST "/api/v1/cashbook/close-day?companyId=$C" '{"date":"2030-01-01","physicalCount":150}'
assert_eq "closing a day in 2030: 400 (was 201)" "$STATUS" "400"
assert_eq "…no close stored" "$(q "select count(*) from \"CashBookDailyClose\" where \"companyId\"='$C'")" "0"
AS POST "/api/v1/cashbook/close-day?companyId=$C" "{\"date\":\"$TODAY\",\"physicalCount\":150}"
assert_eq "closing today: fine" "$STATUS" "201"

note "=== the Anlagenverzeichnis ==="
asset() { AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG Presse\",\"anschaffungsDatum\":\"$1\",\"anschaffungsKosten\":12000,\"nutzungsdauerMonate\":60}"; }
asset "2030-01-01"
assert_eq "an asset acquired in 2030: 400 (was 201)" "$STATUS" "400"
assert_eq "…saying so" "$(P "'Zukunft' in d['message']")" "True"
asset "2025-01-01"
assert_eq "acquired in 2025: recorded" "$STATUS" "201"
A=$(json_field "$BODY" id)
AS PATCH "/api/v1/assets/$A?companyId=$C" '{"anschaffungsDatum":"2030-01-01"}'
assert_eq "moving its acquisition to 2030: 400 (was 200)" "$STATUS" "400"
AS POST "/api/v1/assets/$A/dispose?companyId=$C" '{"verkauftAm":"2030-01-01","verkaufsPreis":500}'
assert_eq "selling it in 2030: 400 (was 201)" "$STATUS" "400"
assert_eq "…it is not sold" "$(q "select \"verkauftAm\" is null from \"Asset\" where id='$A'")" "t"
AS POST "/api/v1/assets/$A/dispose?companyId=$C" "{\"verkauftAm\":\"$TODAY\",\"verkaufsPreis\":500}"
assert_eq "selling it today: recorded" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS")" "ok"

summary
