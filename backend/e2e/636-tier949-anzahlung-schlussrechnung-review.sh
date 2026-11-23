#!/bin/bash
# Tier 949 — what the review of Tier 943 found (advance and final invoices)
#
# Measured on the Tier 948 code:
# 1. the final invoice imported first (booked whole), the advance invoice
#    after it: booked too — 190 + 570 input tax for a supply taxed with 570;
# 2. a credit note deducting advances (the Storno of a final invoice) booked
#    with the whole supply: it took back the paid advance's input tax too;
# 3. an advance invoice entered by hand as "az-…" was not found for "AZ-…";
# 4. more taken off than the invoice says was paid in advance: a warning only;
# 5. a final invoice the advance covers in full: refused as a whole.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-636-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier949-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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

# A CII invoice: file id type date(yyyymmdd) rate net vat gross prepaid payable [preceding invoice]
cii() {
  local ref=""
  [[ -n "${11:-}" ]] && ref="<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${11}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>"
  cat > "$1" <<X
<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>$2</ram:ID><ram:TypeCode>$3</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">$4</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument><ram:SpecifiedTradeProduct><ram:Name>Maschine</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>$6</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>$5</ram:RateApplicablePercent></ram:ApplicableTradeTax><ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>$6</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>Maschinenbau $TAG AG</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>80331</ram:PostcodeCode><ram:LineOne>Weg 1</ram:LineOne><ram:CityName>München</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE811569869</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>$TAG GmbH</ram:Name></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax><ram:CalculatedAmount>$7</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>$6</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>$5</ram:RateApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>$6</ram:LineTotalAmount><ram:TaxBasisTotalAmount>$6</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">$7</ram:TaxTotalAmount><ram:GrandTotalAmount>$8</ram:GrandTotalAmount><ram:TotalPrepaidAmount>$9</ram:TotalPrepaidAmount><ram:DuePayableAmount>${10}</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
      $ref
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
X
}
send() { # preview|import file [paidAt]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/expenses/e-invoice/$1?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$2;type=application/xml" ${3:+--form-string "paidAt=$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
kz66() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "float({k['kz']: k['value'] for k in d['kennzahlen']}.get('66') or 0)"; }
planned() { P "[(float(e['netAmount']), float(e['vatAmount']), float(e['grossAmount'])) for e in d['expenses']]"; }

note "=== 1. the final invoice first, the advance invoice after it ==="
cii "$W/sr1.xml" "SR1-$TAG" 380 20261020 19 3000.00 570.00 3570.00 1190.00 2380.00 "AZ1-$TAG"
send import "$W/sr1.xml"
assert_eq "SR1 booked whole (no advance invoice in the books)" "${STATUS:0:2}" "20"
cii "$W/az1.xml" "AZ1-$TAG" 386 20260910 19 1000.00 190.00 1190.00 0.00 1190.00
send preview "$W/az1.xml"
assert_eq "AZ1 after it: not importable, naming SR1 (was booked: its 190 € a second time)" \
  "$(P "(d['importable'], any('SR1-$TAG' in b for b in d['blocking']))")" "(False, True)"

note "=== 2. a credit note that deducts advances ==="
cii "$W/gs2.xml" "GS2-$TAG" 381 20261025 19 3000.00 570.00 3570.00 1190.00 2380.00 "SR1-$TAG"
send preview "$W/gs2.xml"
assert_eq "the Storno of a final invoice with 1 190 € advances: by hand (was booked −3 000 / −570)" \
  "$(P "(d['importable'], any('Anzahlungen' in b for b in d['blocking']))")" "(False, True)"

note "=== 3. an advance invoice entered by hand in other letters ==="
AS GET "/api/v1/expenses?companyId=$C"
SUP=$(P "[e['supplierId'] for e in d['data'] if e.get('invoiceNumber')=='SR1-$TAG'][0]")
LOWER=$(echo "az3-$TAG" | tr '[:upper:]' '[:lower:]')
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\" $LOWER \",\"description\":\"Anzahlung\",\"invoiceDate\":\"2026-09-11\",\"netAmount\":1000,\"vatRate\":0.19,\"vatAmount\":190,\"grossAmount\":1190}"
cii "$W/sr3.xml" "SR3-$TAG" 380 20261021 19 3000.00 570.00 3570.00 1190.00 2380.00 "AZ3-$TAG"
send preview "$W/sr3.xml"
assert_eq "\" $LOWER \" is AZ3: taken off (was booked whole)" "$(planned)" "[(2000.0, 380.0, 2380.0)]"

note "=== 4. more taken off than was paid in advance ==="
cii "$W/az4.xml" "AZ4-$TAG" 386 20260912 19 1000.00 190.00 1190.00 0.00 1190.00
send import "$W/az4.xml" 2026-09-15
cii "$W/sr4.xml" "SR4-$TAG" 380 20261022 19 3000.00 570.00 3570.00 595.00 2975.00 "AZ4-$TAG"
send preview "$W/sr4.xml"
assert_eq "AZ4 1 190 € in the books, the invoice says 595 € paid in advance: by hand (was 2 000 / 380, a warning)" \
  "$(P "(d['importable'], any('AZ4-$TAG' in b for b in d['blocking']))")" "(False, True)"

note "=== 5. paid in advance in full ==="
cii "$W/az5.xml" "AZ5-$TAG" 386 20260913 19 1000.00 190.00 1190.00 0.00 1190.00
send import "$W/az5.xml" 2026-09-15
cii "$W/sr5.xml" "SR5-$TAG" 380 20261023 19 1000.00 190.00 1190.00 1190.00 0.00 "AZ5-$TAG"
send preview "$W/sr5.xml"
assert_eq "nothing left to book: said so, with where the file belongs" \
  "$(P "(d['expenses'], any('Beleg zur Anzahlungsrechnung' in b for b in d['blocking']))")" "([], True)"

summary
