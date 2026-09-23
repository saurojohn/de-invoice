#!/bin/bash
# Tier 435 — the Kassenbestand never goes below zero
#
# Measured before: an Ausgabe of 80 € into an empty till → 201, balance −80.
# A Kassenminusbestand makes the Kassenbuch not orderly (§ 158 AO). A change
# that takes cash out is refused now when the balance of its day or of any
# later day would fall below zero; adding cash is always allowed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-224-$(date +%s%N | cut -c1-13)"
D0=$(date +%F)
D1=$(date -v-1d +%F 2>/dev/null || date -d "-1 day" +%F)
D2=$(date -v-2d +%F 2>/dev/null || date -d "-2 days" +%F)

register() { # -> "userId companyId"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier435-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(register "$TAG")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
entry() { # date json-fields
  AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$1\",$2}"
}
balance() { AS GET "/api/v1/cashbook/balance?companyId=$C"; json_field "$BODY" balance; }

note "=== 1. an Ausgabe into an empty till ==="
entry "$D2" '"type":"ausgabe","description":"Tanken","amount":80,"vatRate":0.19'
assert_eq "refused (was 201, balance -80)" "$STATUS" "400"
echo "$BODY" | grep -q "negativ" && pass "the message says the balance would go negative" || fail "message: $BODY"

note "=== 2. with an opening balance it fits ==="
entry "$D2" '"type":"eroeffnung","description":"Anfangsbestand","amount":100'
entry "$D2" '"type":"ausgabe","description":"Tanken","amount":80,"vatRate":0.19'
assert_eq "Ausgabe 80 of 100 accepted" "$STATUS" "201"
FUEL=$(json_field "$BODY" id)
entry "$D2" '"type":"umbuchung","description":"Einzahlung Bank","amount":50'
assert_eq "an Umbuchung of 50 with 20 in the till is refused" "$STATUS" "400"

note "=== 3. a backdated Ausgabe may not empty an earlier day ==="
entry "$D0" '"type":"einnahme","description":"Barverkauf","amount":200,"vatRate":0.19'
entry "$D1" '"type":"ausgabe","description":"Porto","amount":50,"vatRate":0'
assert_eq "yesterday would end at -30 (today at +170): refused" "$STATUS" "400"
echo "$BODY" | grep -q "$(date -v-1d +%d.%m.%Y 2>/dev/null || date -d '-1 day' +%d.%m.%Y)" \
  && pass "the message names the day that goes negative" || fail "message: $BODY"
entry "$D0" '"type":"ausgabe","description":"Porto","amount":50,"vatRate":0'
assert_eq "the same Ausgabe today is fine" "$STATUS" "201"

note "=== 4. editing and deleting ==="
AS PUT "/api/v1/cashbook/entries/$FUEL?companyId=$C" '{"amount":130}'
assert_eq "raising the Ausgabe to 130 of 100 is refused" "$STATUS" "400"
AS PUT "/api/v1/cashbook/entries/$FUEL?companyId=$C" '{"amount":70}'
assert_eq "lowering it to 70 is fine" "$STATUS" "200"
EROEFF=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"CashBookEntry\" WHERE \"companyId\"='$C' AND type='eroeffnung'")
AS DELETE "/api/v1/cashbook/entries/$EROEFF?companyId=$C"
assert_eq "deleting the opening balance is refused" "$STATUS" "400"
assert_eq "balance unchanged: 100 - 70 + 200 - 50" "$(balance)" "180"

note "=== 5. a book already negative can be repaired ==="
read -r U C < <(register "$TAG-b")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "INSERT INTO \"CashBookEntry\" (id, \"companyId\", \"businessDate\", type, description, amount, \"createdAt\", \"updatedAt\")
   VALUES ('e2e224-$RANDOM', '$C', '$D1', 'ausgabe', 'Altbestand', 40, now(), now())" >/dev/null
entry "$D0" '"type":"einnahme","description":"Privateinlage","amount":40'
assert_eq "adding cash to a negative book is accepted" "$STATUS" "201"
assert_eq "balance back at 0" "$(balance)" "0"

summary
