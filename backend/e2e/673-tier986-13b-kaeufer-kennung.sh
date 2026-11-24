#!/bin/bash
# Tier 986 — a § 13b e-invoice names the buyer (BT-48 or BT-47)
#
# EN 16931 BR-AE-02: an invoice with VAT category AE (reverse charge) carries
# the buyer's VAT id (BT-48) or legal registration id (BT-47). A domestic
# § 13b recipient often has only a Steuernummer / Handelsregisternummer, and
# the customer had no field for it: a Bauleistung to „Bau Ohne UStId GmbH“
# was issued, its XRechnung REJECTED by KoSIT (BR-AE-02) while the built-in
# check said valid, and the rejected file kept as the archived original
# (§ 14 Abs. 1 Satz 3 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-673-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-1d +%F 2>/dev/null || TZ=Europe/Berlin date -d '1 day ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier986-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
AS POST "/api/v1/customers?companyId=$C" '{"name":"Bau Ohne UStId GmbH","type":"business","contact":{"email":"rechnung@bau-ohne-ustid.example"},"address":{"street":"Ring 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"reverseCharge\":true,\"notes\":\"Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)\",\"items\":[{\"description\":\"Bauleistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
I=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$I/xrechnung/validate?companyId=$C"
assert_eq "the built-in check names BR-AE-02 (was: not checked)" "$(P "d.get('valid')")/$(P "any(e.get('rule')=='BR-AE-02' for e in d.get('errors',[]))")" "False/True"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "issuing: refused, naming what the buyer lacks (was 200, KoSIT REJECT)" "$STATUS/$(P "'BR-AE-02' in d['message']")" "400/True"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"registrationId":"HRB 12345, Amtsgericht Köln"}'
assert_eq "the customer's register number entered" "$STATUS/$(json_field "$BODY" registrationId)" "200/HRB 12345, Amtsgericht Köln"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "now it is issued" "$STATUS" "200"
AS GET "/api/v1/invoices/$I/xrechnung?companyId=$C"
assert_eq "UBL: the buyer's PartyLegalEntity carries it (BT-47)" \
  "$(echo "$BODY" | python3 -c "import sys,re;x=sys.stdin.read();m=re.search(r'<cac:AccountingCustomerParty>.*?<cac:PartyLegalEntity>.*?<cbc:CompanyID>([^<]*)</cbc:CompanyID>',x,re.S);print(m.group(1) if m else '-')")" "HRB 12345, Amtsgericht Köln"
AS GET "/api/v1/invoices/$I/xrechnung/validate?companyId=$C"
assert_eq "…and the built-in check has no BR-AE-02 left" "$(P "any(e.get('rule')=='BR-AE-02' for e in d.get('errors',[]))")" "False"

AS GET "/api/v1/invoices/$I/xrechnung/validate?companyId=$C&engine=kosit"
assert_eq "KoSIT: no BR-AE-02 (was REJECT on it)" "$(P "d.get('engine')")/$(P "any('BR-AE-02' in (e.get('rule','') + e.get('message','')) for e in d.get('errors',[]))")" "kosit/False"

summary
