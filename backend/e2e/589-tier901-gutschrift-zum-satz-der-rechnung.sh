#!/bin/bash
# Tier 901 — a credit note's lines carry the rates of the invoice they reduce
#
# Measured: a 19 % invoice of 1 000 € credited by three lines of 100 € at
# 50 %, 7 % and 0 % — all three were created, and the UStVA showed −100 in
# Kz 35 / 36 (−50 € tax), Kz 86 and Kz 48, while Kz 81 kept the full 1 000.
# A reduction of the price corrects the tax of that supply, at its rate
# (§ 17 Abs. 1 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-589-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier901-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
q="companyId=$C"
CUST='{"name":"Kunde 589 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
AS POST "/api/v1/customers?$q" "$CUST"; K=$(field id)
CUST_AT='{"name":"Wien 589 GmbH","type":"business","vatId":"ATU12345678","address":{"street":"Ring 1","city":"Wien","postalCode":"1010","country":"AT"}}'
AS POST "/api/v1/customers?$q" "$CUST_AT"; KAT=$(field id)
line() { echo "{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}"; }
# invoice CUSTOMER LINES [EXTRA] → id (issued)
invoice() {
  AS POST "/api/v1/invoices?$q" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"${3:-},\"items\":[$2]}"
  local id; id=$(field id)
  AS PUT "/api/v1/invoices/$id/status?$q" '{"status":"sent"}'
  echo "$id"
}
cn() { AS POST "/api/v1/invoices/$1/credit-note?$q" "{\"lines\":[{\"description\":\"Minderung\",\"unitPrice\":100${2:+,\"vatRate\":$2}}]}"; }

note "=== 1. a 19 % invoice ==="
I19=$(invoice "$K" "$(line Leistung 1000 0.19)")
cn "$I19" 0.5
assert_eq "a line at 50 %: refused (was: −100 / −50 in Kz 35 / 36)" "$STATUS" "400"
assert_contains "…names the invoice's rate and the line's" "$BODY" "die Rechnung hat 19 %, nicht 50 %"
cn "$I19" 0.07
assert_eq "a line at 7 %: refused (was: −100 in Kz 86)" "$STATUS" "400"
cn "$I19" 0
assert_eq "a line at 0 %: refused (was: −100 in Kz 48)" "$STATUS" "400"
cn "$I19" 0.19
assert_eq "a line at 19 %: created" "$STATUS" "201"
cn "$I19"
assert_eq "a line without a rate takes the invoice's: created" "$STATUS/$(python3 -c "import json,sys;print([float(i['vatRate']) for i in json.loads(sys.argv[1])['items']])" "$BODY")" "201/[0.19]"

note "=== 2. an invoice with 19 % and 7 % ==="
IMIX=$(invoice "$K" "$(line Beratung 500 0.19),$(line Buch 200 0.07)")
cn "$IMIX" 0.07
assert_eq "a line at 7 %: created" "$STATUS" "201"
cn "$IMIX" 0.16
assert_eq "a line at 16 %: refused" "$STATUS" "400"
assert_contains "…lists both rates" "$BODY" "19 % / 7 %"

note "=== 3. a § 13b invoice (no German tax) ==="
IRC=$(invoice "$KAT" "$(line Montage 800 0)" ',"reverseCharge":true')
cn "$IRC" 0.19
assert_eq "a line at 19 % on a § 13b invoice: refused" "$STATUS" "400"
cn "$IRC" 0
assert_eq "a line at 0 %: created" "$STATUS" "201"

note "=== 4. the UStVA ==="
AS GET "/api/v1/ustva/compute?$q&year=$Y&month=$M"
assert_eq "Kz 81 = 1 000 + 500 − 200 (the two 19 % credit notes), Kz 86 = 200 − 100; nothing in Kz 35 / 48" \
  "$(python3 -c "import json,sys;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('81'), d.get('86'), d.get('35'), d.get('48'))" "$BODY")" \
  "1300 100 None None"

summary
