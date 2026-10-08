#!/bin/bash
# Tier 605 — a supplier invoice with § 13b / intra-community acquisition can
# be created directly
#
# POST /expenses refused `isReverseCharge` and `isIntraEU` ("property …
# should not exist") although the service has handled both for a long time —
# such an expense could only be made on the UStVA page, or created and then
# edited. (Found in the month's reconciliation, Tiers 585–587; spec 349 had
# an assertion that passed for that wrong reason.) The expenses page gets a
# form for entering a supplier invoice by hand, with the tax treatment.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-361-$(date +%s%N | cut -c1-13)"
Y=2026; M=6
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier605-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
mk() { AS POST "/api/v1/expenses?companyId=$C" '{"description":"'"$1"'","invoiceNumber":"'"$2"'","invoiceDate":"'$Y'-06-10"'"$3"'}'; ID=$(json_field "$BODY" id); }
flags() { q "select \"isReverseCharge\"||'/'||\"isIntraEU\"||'/'||\"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2) from \"Expense\" where id='$1'"; }
kz() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"; py 'k={x["kz"]:x for x in d["kennzahlen"]};print('"$1"')'; }

note "=== 1. § 13b at creation ==="
mk "Software aus den USA" RC-1 ',"netAmount":1000,"vatRate":0.19,"vatAmount":0,"grossAmount":1000,"isReverseCharge":true'
assert_eq "POST /expenses with isReverseCharge: 201 (was 400 „property isReverseCharge should not exist“)" "$STATUS/$(flags "$ID")" "201/true/false/1000.00/0.00"
assert_eq "the UStVA owes and deducts 19 % of it (Kz 84 / 85 / 67)" "$(kz 'k["84"]["value"], k["85"]["value"], k["67"]["value"]')" "1000 190 190"

note "=== 2. an intra-community acquisition at creation ==="
mk "Ware aus den Niederlanden" IG-1 ',"netAmount":500,"vatRate":0.19,"vatAmount":0,"grossAmount":500,"isIntraEU":true'
assert_eq "POST /expenses with isIntraEU: 201" "$STATUS/$(flags "$ID")" "201/false/true/500.00/0.00"
assert_eq "the UStVA: Kz 89 base and tax, Kz 61" "$(kz 'k["89"]["value"], k["89"]["tax"], k["61"]["value"]')" "500 95 95"

note "=== 3. what stays refused ==="
N=$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")
mk "13b mit Zeilen" RC-2 ',"isReverseCharge":true,"taxLines":[{"vatRate":0.19,"netAmount":200,"vatAmount":38},{"vatRate":0.07,"netAmount":100,"vatAmount":7}]'
assert_eq "VAT lines on a § 13b expense: 400, and for that reason" "$STATUS/$(echo "$BODY" | grep -c 'Steuerzeilen gibt es nicht bei § 13b')" "400/1"
mk "kein Wahrheitswert" RC-3 ',"netAmount":10,"vatRate":0,"vatAmount":0,"grossAmount":10,"isReverseCharge":"vielleicht"'
assert_eq "a flag that is not a boolean: 400" "$STATUS" "400"
assert_eq "…nothing was stored" "$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")" "$N"

note "=== 4. an ordinary expense is as before ==="
mk "Büromaterial" N-1 ',"netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119'
assert_eq "created, no flag" "$STATUS/$(flags "$ID")" "201/false/false/100.00/19.00"
assert_eq "its VAT is ordinary input tax (Kz 66)" "$(kz 'k["66"]["value"]')" "19"
summary
