#!/bin/bash
# Tier 412 — XRechnung passes the EN 16931 rules
#
# infra/kosit/scenarios.xml ran the UBL schema and the XRechnung schematron
# only; the CEN EN 16931 schematron — the core rules every XRechnung must meet
# — was never installed, so "ACCEPTABLE" meant little. With it installed,
# every invoice this app produced was REJECTED, even a plain one:
#   all        BR-06 / BR-07   no PartyLegalEntity/RegistrationName
#              BR-CL-25        EndpointID schemeID "DE:VAT" (not an EAS code;
#                              the Steuernummer went out as 9931 = Estonian VAT)
#   discount   BR-CO-14/15     tax subtotal from the lines (190) ≠ total tax (171)
#   Skonto     BR-S-08, BR-CO-11  Skonto as an allowance that reduced nothing
#   igL, §13b  BR-E-01, BR-S-01, BR-S-08  0 % lines as S / E, no exemption reason
#   AT buyer   PEPPOL-EN16931-R010  no buyer electronic address
# plus warnings for LineCountNumeric, per-line TaxTotal and listID attributes.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-201-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier412-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS --max-time 180 -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"legalName":"Tier 412 Handels GmbH","registerEntry":"HRB 12345 Amtsgericht Berlin","vatId":"DE123456789","email":"info@t412.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
[[ "$STATUS" == 200 ]] && pass "fixture: seller with address, VAT id, e-mail, register entry" || fail "company PUT → $STATUS $BODY"
customer() { # json
  AS POST "/api/v1/customers?companyId=$C" "$1"; json_field "$BODY" id
}
K=$(customer '{"name":"Kunde AG","type":"business","vatId":"DE987654321","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"k@example.test"}}')
KFR=$(customer '{"name":"Client SARL","type":"business","vatId":"FR12345678901","address":{"street":"1 Rue","city":"Paris","postalCode":"75001","country":"FR"},"contact":{"email":"c@example.test"}}')
KAT=$(customer '{"name":"Wien GmbH","type":"business","vatId":"ATU12345678","address":{"street":"Mariahilfer 10","city":"Wien","postalCode":"1060","country":"Österreich"}}')
KNONE=$(customer '{"name":"Ohne Adresse","type":"business","address":{"street":"Weg 3","city":"Köln","postalCode":"50667","country":"DE"}}')
invoice() { # customer body-fragment
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-09-01\",$2}"
  json_field "$BODY" id
}
L19='{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}'
L0='{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0}'
PLAIN=$(invoice "$K" "\"items\":[$L19]")
DISC=$(invoice "$K" "\"discountPercent\":10,\"items\":[$L19]")
MIXED=$(invoice "$K" '"items":[{"description":"a","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"b","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
MIXDISC=$(invoice "$K" '"discountPercent":10,"items":[{"description":"a","quantity":3,"unit":"Stk","unitPrice":33.33,"vatRate":0.19},{"description":"b","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
SKONTO=$(invoice "$K" "\"skontoPercent\":2,\"skontoDays\":14,\"items\":[$L19]")
IGL=$(invoice "$KFR" "\"euTransaction\":true,\"items\":[$L0]")
RC=$(invoice "$K" "\"reverseCharge\":true,\"items\":[$L0]")
AT=$(invoice "$KAT" "\"items\":[$L19]")
NONE=$(invoice "$KNONE" "\"items\":[$L19]")
[[ -n "$PLAIN" && -n "$DISC" && -n "$MIXED" && -n "$MIXDISC" && -n "$SKONTO" && -n "$IGL" && -n "$RC" && -n "$AT" && -n "$NONE" ]] \
  && pass "fixture: nine invoices" || fail "invoice fixtures ($PLAIN $DISC $MIXED $MIXDISC $SKONTO $IGL $RC $AT $NONE)"

xml() { AS GET "/api/v1/invoices/$1/xrechnung?companyId=$C"; echo "$BODY"; }
has() { # label xml needle
  if grep -qF -- "$3" <<<"$2"; then pass "$1"; else fail "$1 — missing: $3"; fi
}
hasnt() {
  if grep -qF -- "$3" <<<"$2"; then fail "$1 — still present: $3"; else pass "$1"; fi
}

note "=== 1. the real KoSIT verdict (XSD + EN 16931 + XRechnung) ==="
KOSIT_OK=1
for pair in "plain:$PLAIN" "10 % discount:$DISC" "19 % + 7 %:$MIXED" "19 % + 7 % with 10 % discount:$MIXDISC" \
            "Skonto:$SKONTO" "igL 0 %:$IGL" "§13b 0 %:$RC" "Austrian buyer without e-mail:$AT"; do
  label=${pair%%:*}; id=${pair#*:}
  AS GET "/api/v1/invoices/$id/xrechnung/validate?companyId=$C&engine=kosit"
  verdict=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d.get('engine'),d.get('acceptance'),[e.get('message','')[:70] for e in d.get('errors',[])])" "$BODY")
  if [[ "$verdict" == "kosit ACCEPTABLE []" ]]; then pass "$label: ACCEPTABLE"; else fail "$label: $verdict"; KOSIT_OK=0; fi
  AS GET "/api/v1/invoices/$id/xrechnung/validate?companyId=$C"
  assert_eq "$label: in-process check agrees" "$(json_field "$BODY" valid)" "True"
done
[[ $KOSIT_OK == 1 ]] || note "(a KoSIT failure names the EN 16931 / XRechnung rule it broke)"

note "=== 2. parties ==="
X=$(xml "$PLAIN")
has "seller RegistrationName is the legal name (BR-06)" "$X" "<cbc:RegistrationName>Tier 412 Handels GmbH</cbc:RegistrationName>"
has "seller register entry is BT-30" "$X" "<cbc:CompanyID>HRB 12345 Amtsgericht Berlin</cbc:CompanyID>"
has "buyer RegistrationName (BR-07)" "$X" "<cbc:RegistrationName>Kunde AG</cbc:RegistrationName>"
has "seller EndpointID is its e-mail (EM)" "$X" '<cbc:EndpointID schemeID="EM">info@t412.example</cbc:EndpointID>'
has "buyer EndpointID is its e-mail (EM)" "$X" '<cbc:EndpointID schemeID="EM">k@example.test</cbc:EndpointID>'
hasnt "no DE:VAT scheme (BR-CL-25)" "$X" 'DE:VAT'
hasnt "no LineCountNumeric (UBL-CR-011)" "$X" '<cbc:LineCountNumeric'
hasnt "no listID attributes (UBL-CR-656/657/661)" "$X" 'listID='
X=$(xml "$AT")
has "Austrian VAT id is EAS 9914" "$X" '<cbc:EndpointID schemeID="9914">ATU12345678</cbc:EndpointID>'

note "=== 3. the invoice discount is a document allowance ==="
X=$(xml "$DISC")
has "allowance 100.00" "$X" '<cbc:AllowanceTotalAmount currencyID="EUR">100.00</cbc:AllowanceTotalAmount>'
has "lines stay 1000.00" "$X" '<cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>'
has "taxable 900.00" "$X" '<cbc:TaxableAmount currencyID="EUR">900.00</cbc:TaxableAmount>'
has "tax 171.00 (was 190.00 next to a 171.00 total)" "$X" '<cbc:TaxAmount currencyID="EUR">171.00</cbc:TaxAmount>'
hasnt "tax subtotal no longer 190.00" "$X" '<cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>'
has "payable 1071.00" "$X" '<cbc:PayableAmount currencyID="EUR">1071.00</cbc:PayableAmount>'

note "=== 4. Skonto is a payment term ==="
X=$(xml "$SKONTO")
has "#SKONTO#TAGE=14#PROZENT=2.00#" "$X" '#SKONTO#TAGE=14#PROZENT=2.00#'
hasnt "no allowance for Skonto (BR-CO-11)" "$X" '<cac:AllowanceCharge>'
has "payable stays 1190.00" "$X" '<cbc:PayableAmount currencyID="EUR">1190.00</cbc:PayableAmount>'

note "=== 5. 0 % lines carry their tax category ==="
X=$(xml "$IGL")
has "igL: category K" "$X" '<cbc:ID>K</cbc:ID>'
has "igL: VATEX-EU-IC" "$X" '<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>'
has "igL: deliver-to country FR (BR-IC-12)" "$X" '<cac:DeliveryLocation>'
hasnt "igL: no S category" "$X" '<cbc:ID>S</cbc:ID>'
X=$(xml "$RC")
has "§13b: category AE" "$X" '<cbc:ID>AE</cbc:ID>'
has "§13b: VATEX-EU-AE" "$X" '<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>'
has "§13b: payable 1000.00" "$X" '<cbc:PayableAmount currencyID="EUR">1000.00</cbc:PayableAmount>'

note "=== 6. a buyer with no electronic address is reported, not sent ==="
AS GET "/api/v1/invoices/$NONE/xrechnung/validate?companyId=$C"
assert_eq "in-process check fails" "$(json_field "$BODY" valid)" "False"
assert_eq "rule PEPPOL-EN16931-R010" \
  "$(python3 -c "import sys,json;print(any(e['rule']=='PEPPOL-EN16931-R010' for e in json.loads(sys.argv[1])['errors']))" "$BODY")" "True"

summary; exit $?
