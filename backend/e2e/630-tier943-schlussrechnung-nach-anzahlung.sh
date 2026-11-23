#!/bin/bash
# Tier 943 — an incoming final invoice after an advance invoice (e-invoice import)
#
# § 14 Abs. 5 Satz 2 UStG: the final invoice shows the whole supply and its
# tax and deducts the advances paid with their tax (EN 16931: BT-113 paid
# amount, BT-25 the advance invoice). The advance invoice's input tax was
# deducted with it (§ 15 Abs. 1 Satz 1 Nr. 1 Satz 3 UStG).
# Measured before: the final invoice was booked as the whole — its 570 €
# input tax in October after the advance's 190 € in September: 760 € deducted
# for a supply taxed with 570 €, and 3 570 € owed to the supplier, not 2 380 €.
#
# Fixture (a GmbH, Soll): AZ 1 000 + 190 (10.09.2026, paid 15.09.); SR 3 000 +
# 570, 1 190 paid, 2 380 due (20.10.2026, naming AZ).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-630-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier943-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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

note "=== the advance invoice ==="
cii "$W/az.xml" "AZ-$TAG" 386 20260910 19 1000.00 190.00 1190.00 0.00 1190.00
send import "$W/az.xml" 2026-09-15
assert_eq "AZ (386, paid 15.09.) is booked" "${STATUS:0:2}" "20"
assert_eq "September: its 190 € input tax" "$(kz66 2026 9)" "190.0"

note "=== the final invoice ==="
cii "$W/sr.xml" "SR-$TAG" 380 20261020 19 3000.00 570.00 3570.00 1190.00 2380.00 "AZ-$TAG"
send preview "$W/sr.xml"
assert_eq "preview: the rest is booked — 2 000 + 380 = 2 380 (was 3 000 + 570)" "$(planned)" "[(2000.0, 380.0, 2380.0)]"
assert_eq "…and says so, naming the advance invoice" \
  "$(P "any('AZ-$TAG' in w and '§ 14 Abs. 5' in w for w in d['warnings'])")" "True"
send import "$W/sr.xml"
assert_eq "SR is booked" "${STATUS:0:2}" "20"
assert_eq "October: 380 € input tax (was 570 — the advance's 190 € a second time)" "$(kz66 2026 10)" "380.0"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "the bill: 2 380 € owed, the amount due; the note says what was taken off" \
  "$(P "[(float(e['grossAmount']), 'Anzahlungsrechnung AZ-$TAG abgezogen' in (e.get('notes') or '')) for e in d['data'] if e.get('invoiceNumber')=='SR-$TAG']")" "[(2380.0, True)]"

note "=== an advance invoice not in the books ==="
cii "$W/sr2.xml" "SR2-$TAG" 380 20261021 19 3000.00 570.00 3570.00 1190.00 2380.00 "AZ2-$TAG"
send preview "$W/sr2.xml"
# the advance may have been paid without an advance invoice, or booked elsewhere: booked whole, said
assert_eq "booked whole (3 000 + 570)" "$(planned)" "[(3000.0, 570.0, 3570.0)]"
assert_eq "…with a warning that AZ2 is not in the books" \
  "$(P "any('AZ2-$TAG' in w and 'nicht erfasst' in w for w in d['warnings'])")" "True"
assert_eq "…importable" "$(P "d['importable']")" "True"

note "=== an advance invoice that does not fit ==="
cii "$W/az3.xml" "AZ3-$TAG" 386 20261001 7 1000.00 70.00 1070.00 0.00 1070.00
send import "$W/az3.xml" 2026-10-02
cii "$W/sr3.xml" "SR3-$TAG" 380 20261022 19 3000.00 570.00 3570.00 1070.00 2500.00 "AZ3-$TAG"
send preview "$W/sr3.xml"
# its 7 % are not in the final invoice's 19 %: booking would be a guess
assert_eq "an AZ at 7 % against a final invoice at 19 %: not importable, said why" \
  "$(P "(d['importable'], any('AZ3-$TAG' in b for b in d['blocking']))")" "(False, True)"

summary
