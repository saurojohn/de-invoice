#!/bin/bash
# Tier 586 — a credit note is a valid e-invoice
#
# Both generators wrote every document as an invoice (type 380). A credit
# note is stored negative, so its XRechnung / ZUGFeRD carried a negative
# unit price — which EN 16931 forbids (BR-27) and the project's own check
# reported ("Einzelpreis darf nicht negativ sein"). That held for every
# Storno credit note and for the credit note a Skonto payment creates.
# Now: type 381, amounts positive, the corrected invoice named (BG-3); in
# UBL a `CreditNote` document.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-352-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
D=$(mktemp -d)
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier586-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C" DE811907980
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
get() { curl -sS -o "$2" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
up() { # path file → BODY
  BODY=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$2" "$API$1")
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
# what a document says about itself: root / type code / min price / payable / referenced invoice
facts() { python3 - "$1" <<'PY'
import re, sys
x = open(sys.argv[1], encoding='utf-8').read()
root = re.search(r'<(?:\w+:)?(Invoice|CreditNote|CrossIndustryInvoice)[\s>]', x).group(1)
code = (re.search(r'<cbc:(?:InvoiceTypeCode|CreditNoteTypeCode)>(\d+)<', x) or re.search(r'<rsm:ExchangedDocument>.*?<ram:TypeCode>(\d+)<', x, re.S)).group(1)
prices = [float(v) for v in re.findall(r'<cbc:PriceAmount[^>]*>([^<]+)<', x)]
payable = re.search(r'<cbc:PayableAmount[^>]*>([^<]+)<', x).group(1)
ref = re.search(r'<cac:InvoiceDocumentReference>\s*<cbc:ID>([^<]+)<', x)
print(root, code, 'minPrice=%.2f' % min(prices), 'payable=' + payable, 'ref=' + (ref.group(1) if ref else '-'))
PY
}

company A
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde GmbH","type":"business","vatId":"DE136695976","contact":{"email":"kunde@example.test"},"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Beratung","quantity":2,"unit":"Std","unitPrice":150,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]}'
INV=$(json_field "$BODY" id); NR=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"reason":"Storno"}'
CN=$(json_field "$BODY" id); CNR=$(json_field "$BODY" invoiceNumber)
assert_eq "fixture: an invoice of 464,00 and its credit note" "$STATUS/$(json_field "$BODY" total | cut -c1-4)" "201/-464"

note "=== 1. the credit note as XRechnung ==="
get "/api/v1/invoices/$CN/xrechnung?companyId=$C" "$D/cn.xml"
assert_eq "a CreditNote document, type 381, prices and amount positive, the invoice named" \
  "$(facts "$D/cn.xml")" "CreditNote 381 minPrice=100.00 payable=464.00 ref=$NR"
assert_eq "…with CreditNoteLine / CreditedQuantity and no DueDate" \
  "$(grep -c '<cac:CreditNoteLine>' "$D/cn.xml")/$(grep -c '<cbc:CreditedQuantity' "$D/cn.xml")/$(grep -c 'InvoiceLine\|InvoicedQuantity\|<cbc:DueDate' "$D/cn.xml")" "2/2/0"
AS GET "/api/v1/invoices/$CN/xrechnung/validate?companyId=$C"
assert_eq "the project's own check passes (was: BR-22, negative unit price)" "$(py 'print(d["valid"], [e["rule"] for e in d["errors"]])')" "True []"
get "/api/v1/invoices/$INV/xrechnung?companyId=$C" "$D/inv.xml"
assert_eq "the invoice itself is written as before" "$(facts "$D/inv.xml")" "Invoice 380 minPrice=100.00 payable=464.00 ref=-"

note "=== 2. the credit note as ZUGFeRD, read back ==="
get "/api/v1/invoices/$CN/zugferd?companyId=$C" "$D/cn.pdf"
up "/api/v1/expenses/e-invoice/preview?companyId=$C" "$D/cn.pdf"
assert_eq "the embedded XML: type 381, a credit note, the invoice named, amounts positive" \
  "$(py 'i=d["invoice"];print(i["typeCode"], i["creditNote"], i["precedingInvoice"], i["totals"]["net"], i["totals"]["tax"], i["totals"]["payable"])')" "381 True $NR 400 64 464"
up "/api/v1/expenses/e-invoice/preview?companyId=$C" "$D/cn.xml"
assert_eq "the UBL file reads back the same" \
  "$(py 'i=d["invoice"];print(i["syntax"], i["typeCode"], i["creditNote"], i["precedingInvoice"], i["totals"]["net"], i["totals"]["tax"], i["totals"]["payable"], [l["unitPrice"] for l in i["lines"]])')" "ubl-creditnote 381 True $NR 400 64 464 [150, 100]"

note "=== 3. the official validator (Tier 588: it has a scenario for a UBL credit note) ==="
# a complete issuer, so that nothing but the document's form is in question
AS PUT "/api/v1/companies/$C?companyId=$C" '{"legalName":"Tier 586 Handels GmbH","registerEntry":"HRB 12345 Amtsgericht Berlin","vatId":"DE811907980","email":"info@t586.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
assert_eq "fixture: the issuer is complete" "$STATUS" "200"
get "/api/v1/invoices/$CN/xrechnung?companyId=$C" "$D/cn2.xml"
get "/api/v1/invoices/$CN/zugferd?companyId=$C" "$D/cn2.pdf"
up "/api/v1/expenses/e-invoice/validate?companyId=$C" "$D/cn2.pdf"
if [[ "$(py 'print(d["available"])')" == "True" ]]; then
  assert_eq "ZUGFeRD credit note: accepted (schema and EN 16931 rules)" "$(py 'print(d["acceptance"], d["schema"], d["schematron"], len(d["errors"]))')" "ACCEPTABLE Y Y 0"
  up "/api/v1/expenses/e-invoice/validate?companyId=$C" "$D/cn2.xml"
  assert_eq "UBL credit note: accepted — schema, EN 16931 and XRechnung rules (was: REJECT without a finding, no scenario)" \
    "$(py 'print(d["acceptance"], d["schema"], d["schematron"], [e["rule"] for e in d["errors"]])')" "ACCEPTABLE Y Y []"
  AS GET "/api/v1/invoices/$CN/xrechnung/validate?companyId=$C&engine=kosit"
  assert_eq "engine=kosit on the credit note itself" "$(py 'print(d["engine"], d["acceptance"], d["schema"], len(d["errors"]))')" "kosit ACCEPTABLE Y 0"
  # the validator still refuses a credit note that is wrong: the old form
  sed -e 's|<cbc:PriceAmount currencyID="EUR">150.00|<cbc:PriceAmount currencyID="EUR">-150.00|' "$D/cn2.xml" > "$D/bad.xml"
  up "/api/v1/expenses/e-invoice/validate?companyId=$C" "$D/bad.xml"
  assert_eq "…and a negative unit price in a credit note is rejected by it (BR-27)" "$(py 'print(d["acceptance"], "BR-27" in [e["rule"] for e in d["errors"]])')" "REJECT True"
else
  note "KoSIT validator not installed here — the official checks are skipped"
fi

note "=== 4. the credit note a Skonto payment creates ==="
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","skontoPercent":2,"skontoDays":14,"items":[{"description":"Beratung","quantity":1,"unit":"Std","unitPrice":1000,"vatRate":0.19}]}'
S2=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$S2/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$S2/payments?companyId=$C" '{"amount":1166.20,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
SK=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select id from \"Invoice\" where \"referenceInvoiceId\"='$S2' and type='CN'")
[[ -n "$SK" ]] && pass "fixture: the Skonto credit note exists" || fail "no Skonto credit note"
get "/api/v1/invoices/$SK/xrechnung?companyId=$C" "$D/sk.xml"
assert_eq "…type 381, 23,80 positive" "$(facts "$D/sk.xml" | cut -d' ' -f1,2,4)" "CreditNote 381 payable=23.80"
AS GET "/api/v1/invoices/$SK/xrechnung/validate?companyId=$C"
assert_eq "…and it passes the check" "$(py 'print(d["valid"])')" "True"

note "=== 5. another company receives it ==="
company B
up "/api/v1/expenses/e-invoice/preview?companyId=$C" "$D/cn.xml"
assert_eq "the importer proposes a credit note of 464,00" "$(py 'i=d["invoice"];print(i["creditNote"], i["number"], i["totals"]["gross"])')" "True $CNR 464"
rm -rf "$D"
summary
