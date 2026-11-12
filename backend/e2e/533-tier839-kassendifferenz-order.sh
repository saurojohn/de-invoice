#!/bin/bash
# Tier 839 — a counted difference is not booked before a closed day.
#
# Since Tier 838 the Tagesabschluss books its difference, and reopening the day
# takes it back. Both are bookings on that day — and the Kassenbuch is kept in
# order of time (§ 146 Abs. 1 AO; Tier 524 refuses an entry before a closed
# day). Measured on Tier 838: with 02.10. closed (Endbestand 857 €), closing
# 01.10. with a Fehlbetrag of 2 € booked it on 01.10.: the book said 855 € at
# the end of 02.10., its signed close 857 €. Reopening 05.10. with 06.10.
# closed took a Fehlbetrag back the same way. Now both are refused as an
# entry before a closed day is; a close without a difference books nothing
# and stays allowed in any order.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-533-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier839-e2e\",\"companyName\":\"$TAG Laden\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: company" || { fail "register"; summary; exit 1; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
Q="companyId=$C"
E() { AS POST "/api/v1/cashbook/entries?$Q" "$1"; assert_status 201 "fixture: $2"; }
balance() { AS GET "/api/v1/cashbook/balance?$Q"; py "print('%.2f' % d['balance'])"; }
# the Endbestand of the day's close and the book's figure at its end
close_vs_book() {
  AS GET "/api/v1/cashbook/closes?$Q&from=$1&to=$1"
  local closed; closed=$(py "r=d if isinstance(d,list) else d.get('data',d); print('%.2f' % float(r[0]['endbestand']))")
  AS GET "/api/v1/cashbook/day?$Q&date=$1"
  echo "$closed $(py "print('%.2f' % d['ende'])")"
}
E '{"businessDate":"2026-10-01","type":"eroeffnung","description":"Anfangsbestand","amount":500}' "opening balance 500"
E '{"businessDate":"2026-10-01","type":"einnahme","description":"Tageslosung","amount":119,"vatRate":0.19}' "takings 119 on 01.10."
E '{"businessDate":"2026-10-02","type":"einnahme","description":"Tageslosung","amount":238,"vatRate":0.19}' "takings 238 on 02.10."
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-02","physicalCount":857}'
assert_status 201 "fixture: 02.10. closed first, counted exactly 857"

note "=== 1. closing an earlier day with a difference ==="
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-01","physicalCount":617,"differenzNote":"Wechselgeld"}'
assert_status 400 "01.10. with a Fehlbetrag of 2 € is refused (was 201: booked before the closed 02.10.)"
echo "$BODY" | grep -q "02.10.2026 ist bereits abgeschlossen" \
  && pass "the message names the closed day" || fail "the message names the closed day: $BODY"
assert_eq "the Kassenbestand is still 857 (was 855)" "$(balance)" "857.00"
assert_eq "02.10.'s signed Endbestand = the book's (was 857 / 855)" "$(close_vs_book 2026-10-02)" "857.00 857.00"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-01","physicalCount":619}'
assert_status 201 "01.10. counted exactly is closed after 02.10. — nothing is booked"

note "=== 2. reopening an earlier day that has a difference ==="
E '{"businessDate":"2026-10-05","type":"einnahme","description":"Tageslosung","amount":100,"vatRate":0.19}' "takings 100 on 05.10."
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-05","physicalCount":955,"differenzNote":"nicht aufklärbar"}'
assert_status 201 "05.10. closed with a Fehlbetrag of 2 € (the latest day: booked)"
E '{"businessDate":"2026-10-06","type":"einnahme","description":"Tageslosung","amount":10,"vatRate":0.19}' "takings 10 on 06.10."
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-06","physicalCount":965}'
assert_status 201 "fixture: 06.10. closed, counted exactly 965"
AS POST "/api/v1/cashbook/reopen-day?$Q" '{"date":"2026-10-05"}'
assert_status 400 "reopening 05.10. is refused while 06.10. is closed (was 201: the Fehlbetrag taken back)"
assert_eq "the Kassenbestand is still 965 (was 967)" "$(balance)" "965.00"
assert_eq "06.10.'s signed Endbestand = the book's (was 965 / 967)" "$(close_vs_book 2026-10-06)" "965.00 965.00"
AS POST "/api/v1/cashbook/reopen-day?$Q" '{"date":"2026-10-02"}'
assert_status 201 "02.10. (no difference) may still be reopened — nothing is taken back"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-02","physicalCount":857}'
assert_status 201 "fixture: 02.10. closed again"

note "=== 3. the latest day first, then back ==="
AS POST "/api/v1/cashbook/reopen-day?$Q" '{"date":"2026-10-06"}'
assert_status 201 "06.10. reopened"
AS POST "/api/v1/cashbook/reopen-day?$Q" '{"date":"2026-10-05"}'
assert_status 201 "then 05.10.: the Fehlbetrag goes with its close"
assert_eq "the book's 967 again" "$(balance)" "967.00"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-05","physicalCount":955,"differenzNote":"nicht aufklärbar"}'
assert_status 201 "05.10. counted again, the Fehlbetrag booked again"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-06","physicalCount":965}'
assert_status 201 "06.10. closed again, counted exactly"
assert_eq "06.10.'s Endbestand = the book's = the till" "$(close_vs_book 2026-10-06)" "965.00 965.00"
summary
