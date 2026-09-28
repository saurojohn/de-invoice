#!/bin/bash
# Tier 463 — a UStVA with negative input tax can be filed
#
# Measured before: a month with only a supplier credit note (Tier 442) has
# Vorsteuer −19 €; POST /ustva/filings answered 400 ("vorsteuerSum must not be
# less than 0", from19 and total the same) — the month could not be declared.
# A negative Kz 66 is legitimate (§ 17 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-252-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier463-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS PUT "/api/v1/companies/$C?companyId=$C" '{"taxId":"123/456/78901"}'   # ELSTER needs a Steuernummer
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"invoiceNumber":"GS-1","description":"Gutschrift","invoiceDate":"'$Y'-03-10","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119,"creditNote":true}'
assert_eq "a supplier credit note" "$STATUS" "201"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=3"
assert_eq "March: Vorsteuer -19" "$(py 'print(d["vorsteuerSum"])')" "-19"
echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);d['status']='submitted';print(json.dumps(d))" > /tmp/t463.json
curl -sS -o /tmp/t463-r.json -w "%{http_code}" -X POST "$API/api/v1/ustva/filings?companyId=$C" \
  -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d @/tmp/t463.json > /tmp/t463-s.txt
assert_eq "March can be filed (was 400)" "$(cat /tmp/t463-s.txt)" "201"
assert_eq "stored: input tax -19, 19 to pay back (Zahllast = 0 - (-19))" \
  "$(python3 -c "import json;d=json.load(open('/tmp/t463-r.json'));print(float(d['inputVat']), float(d['payableVat']))")" "-19.0 19.0"
FID=$(python3 -c "import json;print(json.load(open('/tmp/t463-r.json'))['id'])")
curl -sS -o /tmp/t463.xml -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/filings/$FID/elster-xml?companyId=$C"
assert_eq "ELSTER: Kz 66 negative, Kz 83 the 19 to pay" \
  "$(grep -oE 'Kz0(66|83)=[-+0-9]+' /tmp/t463.xml | tr '\n' ' ')" "Kz066=-000000001900 Kz083=+000000001900 "

summary
