#!/bin/bash
# Tier 983 — a counted till holds no negative cash
#
# The Kassensturz took a negative count: opening 100 €, counted −50 € —
# 201, Endbestand −50, a „Kassenfehlbetrag“ of 150 € booked, the balance −50.
# A Kassenminusbestand is what Tier 435 refuses on every other path: the book
# is no longer orderly and the tax office may estimate (§ 146 Abs. 1, § 158 AO);
# the close also signed the −50 into its hash.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-670-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier983-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":100}"
AS POST "/api/v1/cashbook/close-day?companyId=$C" "{\"date\":\"$D\",\"physicalCount\":-50,\"differenzNote\":\"Zählfehler\"}"
assert_eq "a count of −50 €: refused, saying why (was 201, Endbestand −50)" "$STATUS/$(json_field "$BODY" message | grep -c negativ)" "400/1"
AS GET "/api/v1/cashbook/balance?companyId=$C"
assert_eq "…the till still holds 100 €, no Fehlbetrag booked" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(float(d.get('balance', d.get('saldo', d.get('bestand', -1)))))" "$BODY")" "100.0"
AS POST "/api/v1/cashbook/close-day?companyId=$C" "{\"date\":\"$D\",\"physicalCount\":0,\"differenzNote\":\"Kasse entwendet\"}"
assert_eq "a count of 0 €: the day closes (the 100 € a Fehlbetrag)" "$STATUS" "201"

summary
