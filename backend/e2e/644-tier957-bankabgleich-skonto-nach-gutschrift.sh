#!/bin/bash
# Tier 957 — the bank match: a payment less Skonto after a credit note
#
# A bank line of the invoice's total less its Skonto is suggested for it
# (Tier 52). Only when nothing was paid: after a credit note (goods returned)
# the customer pays the rest less the Skonto on it — 1 190 € invoice, 595 €
# credited, 583,10 € received with no number in the purpose: no suggestion
# (the amount was neither the open 595 € nor 1 190 € less 2 %).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-644-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier957-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$TODAY\",\"skontoPercent\":2,\"skontoDays\":14,\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":595,"reason":"Rücksendung"}'
assert_eq "1 190 € invoice with 2 % Skonto, 595 € credited" "${STATUS:0:2}" "20"

D=$(echo "$TODAY" | tr -d '-' | cut -c3-8); MD=${D:2:4}
cat > "$W/st.mt940" <<X
:1:F01BANKBICAXXX0000000000
:20:ST957
:25:DE89370400440532013000
:28C:1/1
:60F:C${D}EUR1000,00
:61:${D}${MD}C583,10NTRFNONREF//Zahlung
Kunde
:62F:C${D}EUR1583,10
-
X
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$W/st.mt940;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U")
SID=$(json_field "$UP" id)
T=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['transactions'][0]['id'])" 2>/dev/null)
AS GET "/api/v1/bank-statements/$SID/transactions/$T/candidates?companyId=$C"
assert_eq "583,10 € received (595 less 2 %): the invoice suggested, as a payment less Skonto (was none)" \
  "$(P "[c['matchReason'].split(' + ')[0] for c in d.get('candidates', []) if c.get('invoiceId') == '$I']")" "['amount less 2 % Skonto']"

summary
