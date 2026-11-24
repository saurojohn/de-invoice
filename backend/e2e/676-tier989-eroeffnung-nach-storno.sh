#!/bin/bash
# Tier 989 — after a Storno of the opening balance, the right one can be booked
#
# Opening balance 5 000 € (a typo), reversed: the new opening balance of 500 €
# was refused — „Es existiert bereits ein Eröffnungs-Eintrag. Für eine
# Korrektur buchen Sie eine Storno-Buchung.“ — the Storno it asks for had been
# booked. The right Anfangsbestand could only go in as an Einnahme.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-676-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days ago' +%F)
D2=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier989-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
CE() { AS POST "/api/v1/cashbook/entries?companyId=$C" "$1"; E=$(json_field "$BODY" id); }
CE "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB (Tippfehler)\",\"amount\":5000}"
AS POST "/api/v1/cashbook/entries/$E/reverse?companyId=$C" '{"reason":"Tippfehler, richtig 500"}'
assert_eq "fixture: an opening balance of 5 000 €, reversed" "$STATUS" "201"
CE "{\"businessDate\":\"$D2\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":500}"
assert_eq "the right opening balance, the day after: booked (was 400, 'Storno-Buchung')" "$STATUS" "201"
AS GET "/api/v1/cashbook/balance?companyId=$C"
assert_eq "…the till holds 500 €" "$(json_field "$BODY" balance)" "500"
CE "{\"businessDate\":\"$D2\",\"type\":\"eroeffnung\",\"description\":\"AB zweimal\",\"amount\":100}"
assert_eq "a second live opening balance: refused, as before" "$STATUS" "400"

summary
