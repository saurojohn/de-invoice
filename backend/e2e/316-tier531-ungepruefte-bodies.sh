#!/bin/bash
# Tier 531 — a malformed body is a 400, not a 500
#
# 35 routes take a body typed by an interface, which the validation pipe does
# not check. Each was sent `{}`, `[]`, a string, `null` and bodies with fields
# of the wrong type. Measured: 500 on
#   - POST /auth/forgot-password   {"email": {…}}        (public)
#   - POST /auth/reset-password    {"token": 5, "password": []}  (public)
#   - POST /users/me/switch-company {"companyId": 123}
#   - POST /customers|expenses|products/import with a row that is null / a
#     number / a string, or a field holding an object.
# Now each is a 400 (forgot-password keeps its generic 200).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-316-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier531-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }

note "=== the public password routes ==="
PUB POST "/api/v1/auth/forgot-password" '{"email":{"a":1}}'
assert_eq "forgot-password with an object as e-mail: the generic 200 (was 500)" "$STATUS" "200"
PUB POST "/api/v1/auth/forgot-password" '{"email":["a@example.test"]}'
assert_eq "…with a list: 200" "$STATUS" "200"
PUB POST "/api/v1/auth/reset-password" '{"token":5,"password":[]}'
assert_eq "reset-password with a number and a list: 400 (was 500)" "$STATUS" "400"
PUB POST "/api/v1/auth/reset-password" '{"token":{"a":1},"password":"Neues-Passwort-1"}'
assert_eq "…with an object as token: 400 (was 500)" "$STATUS" "400"

note "=== switch-company ==="
AS POST "/api/v1/users/me/switch-company" '{"companyId":123}'
assert_eq "a number as companyId: 400 (was 500)" "$STATUS" "400"
AS POST "/api/v1/users/me/switch-company" "{\"companyId\":\"$C\"}"
assert_eq "the user's own company: fine" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS $BODY")" "ok"

note "=== the imports ==="
for R in customers expenses products; do
  for ROWS in '[null]' '[5]' '["x"]' '[[1,2]]' '[{"name":{"a":1},"description":{"a":1}}]' '[{"name":"ok","description":"ok","invoiceDate":"2026-09-01","netAmount":"10","notes":[{"a":1}]}]'; do
    AS POST "/api/v1/$R/import?companyId=$C" "{\"rows\":$ROWS}"
    assert_eq "$R import, rows $ROWS: 400 (was 500, or 201 with the row reported as empty)" "$STATUS" "400"
  done
done
assert_eq "…the message names the row" "$(P "'Zeile 1' in d['message']")" "True"
assert_eq "…nothing imported" "$(q "select (select count(*) from \"Customer\" where \"companyId\"='$C')+(select count(*) from \"Expense\" where \"companyId\"='$C')+(select count(*) from \"Product\" where \"companyId\"='$C')")" "0"
AS POST "/api/v1/customers/import?companyId=$C" "{\"rows\":[{\"name\":\"$TAG Kunde\",\"tags\":[\"vip\",\"b2b\"]}]}"
assert_eq "a customer row with a list of tags: imported" "$STATUS/$(P "d['imported']")" "201/1"
AS POST "/api/v1/products/import?companyId=$C" "{\"rows\":[{\"name\":\"$TAG Ware\",\"basePrice\":\"9,90\",\"vatRate\":0.19}]}"
assert_eq "a product row with a number and a string: imported" "$STATUS/$(P "d['imported']")" "201/1"

summary
