#!/bin/bash
# Tier 972 — a cash entry and its Storno stand as a pair
#
# Neither a reversed entry nor its Storno was protected: the reversed sale of
# 119 € was changed to 357 € while marked storniert (the UStVA took Kz 81
# 200 €), the Storno set to 0 and then deleted on its own — the original live
# again with no Storno left. § 146 Abs. 4 AO, GoBD Rz. 58-60.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-659-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier972-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
CE() { AS POST "/api/v1/cashbook/entries?companyId=$C" "$1"; E=$(json_field "$BODY" id); }
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=${D:0:4}&month=$((10#${D:5:2}))"; P "float({k['kz']: k['value'] for k in d['kennzahlen']}.get('81') or 0)"; }
CE "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":500}"
CE "{\"businessDate\":\"$D\",\"type\":\"einnahme\",\"description\":\"Verkauf\",\"amount\":119,\"vatRate\":0.19}"; ORIG=$E
AS POST "/api/v1/cashbook/entries/$ORIG/reverse?companyId=$C" '{"reason":"Fehlbuchung"}'
ST=$(json_field "$BODY" id)
assert_eq "a cash sale of 119 €, reversed: no sale in the UStVA" "$(kz81)" "0.0"

AS PUT "/api/v1/cashbook/entries/$ORIG?companyId=$C" '{"amount":357}'
assert_eq "the reversed sale changed: refused (was 200 — 357 € marked storniert, Kz 81 200 €)" "$STATUS" "400"
AS PUT "/api/v1/cashbook/entries/$ST?companyId=$C" '{"amount":0}'
assert_eq "the Storno set to 0: refused (was 200)" "$STATUS" "400"
AS DELETE "/api/v1/cashbook/entries/$ST?companyId=$C"
assert_eq "the Storno deleted on its own: refused (was 200 — the original live again)" "$STATUS" "400"
AS DELETE "/api/v1/cashbook/entries/$ORIG?companyId=$C"
assert_eq "the reversed sale deleted: refused" "$STATUS" "400"
assert_eq "the UStVA unchanged" "$(kz81)" "0.0"
CE "{\"businessDate\":\"$D\",\"type\":\"einnahme\",\"description\":\"Verkauf neu\",\"amount\":238,\"vatRate\":0.19}"
AS PUT "/api/v1/cashbook/entries/$E?companyId=$C" '{"amount":0}'
assert_eq "an amount of 0 on an ordinary entry: refused, as on create" "$STATUS" "400"

summary
