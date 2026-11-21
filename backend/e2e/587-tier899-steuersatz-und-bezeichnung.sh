#!/bin/bash
# Tier 899 — an invoice is issued with a rate German law has and with every
# line saying what was supplied
#
# Measured: a line at 50 % (or 16 % / 5 % today) to a customer in Berlin was
# issued — the UStVA declared it in Kz 35 / 36 — and so was a line with an
# empty description (§ 14 Abs. 4 Nr. 5 UStG; BT-153 of the e-invoice). Both
# are refused when issuing now. A rate of another member state stays allowed
# for a sale to a consumer there (OSS), 16 % for a supply in the second half
# of 2020.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-587-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier899-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Inland 587 GmbH","type":"business","address":{"street":"Weg 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
DE=$(field id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
FR=$(field id)

# issue CUSTOMER LINE-JSON [EXTRA-JSON] — sets STATUS / BODY of the issue
issue() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"${3:-},\"items\":[$2]}"
  [[ "$STATUS" == "201" ]] || { echo "create: $STATUS $BODY"; return; }
  local id; id=$(field id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
line() { echo "{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}"; }

issue "$DE" "$(line Beratung 1000 0.5)"
assert_eq "50 % to a customer in Berlin: refused (was: issued)" "$STATUS" "400"
assert_contains "names the rate" "$BODY" "50 % gibt es nicht"
issue "$DE" "$(line Beratung 1000 0.16)"
assert_eq "16 % for a supply today: refused (was: issued)" "$STATUS" "400"
assert_contains "names the rate" "$BODY" "16 % gibt es nicht"
issue "$DE" "$(line Beratung 1000 0.16)" ',"deliveryDate":"2020-11-16"'
assert_eq "16 % for a supply on 16.11.2020: issued" "$STATUS" "200"
issue "$DE" "$(line Beratung 1000 0.19)"
assert_eq "19 %: issued" "$STATUS" "200"
issue "$DE" "$(line Fachbuch 40 0.07)"
assert_eq "7 %: issued" "$STATUS" "200"
issue "$FR" "$(line Ware 100 0.2)"
assert_eq "20 % to a consumer in France (OSS): issued" "$STATUS" "200"

issue "$DE" "$(line '  ' 1000 0.19)"
assert_eq "a line without a description: refused (was: issued)" "$STATUS" "400"
assert_contains "says what is missing" "$BODY" "Bezeichnung der Leistung in jeder Position"
issue "$DE" "$(line Montage 50 0.19),$(line '' 30 0.19)"
assert_eq "a Kleinbetragsrechnung with an empty line: refused too (§ 33 UStDV)" "$STATUS" "400"
assert_contains "says what is missing" "$BODY" "Bezeichnung der Leistung"
summary
