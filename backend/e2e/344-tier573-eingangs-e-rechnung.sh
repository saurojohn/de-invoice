#!/bin/bash
# Tier 573 — an incoming e-invoice is read, booked and kept
#
# Receiving e-invoices is mandatory since 01.01.2025 (§ 27 Abs. 38 UStG).
# Measured before: an .xml upload → 400 "Dateityp nicht erlaubt"; a ZUGFeRD PDF
# went through OCR like a photographed receipt, the invoice inside it unread.
# Now POST /expenses/e-invoice/preview and /import read XRechnung (UBL and CII)
# and the XML embedded in a ZUGFeRD / Factur-X PDF, create the supplier and one
# expense per VAT rate, and keep the received file unchanged as the Beleg.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-344-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d)
register() { # label → "userId companyId"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier573-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(register Empfaenger)
read -r SU SC < <(register Absender)
[[ -n "${C:-}" && -n "${SC:-}" ]] && pass "fixture: a receiving and a sending company" || { fail "register"; summary; exit 1; }
BUYER="$TAG Empfaenger GmbH"
OWN_VAT="DE136695976"
BODY_R="{\"vatId\":\"$OWN_VAT\"}"
curl -s -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$BODY_R"

# send FILE to ROUTE as the receiving company; status on stdout, body in $D/out
send() { # route file [curl args…]
  local route="$1" file="$2"; shift 2
  curl -s -o "$D/out" -w '%{http_code}' -m 60 -X POST "$API/api/v1/expenses/e-invoice/$route?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$file" "$@"
}
out() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$D/out" "$1" 2>/dev/null; }
get() { curl -s -o "$D/out" -w '%{http_code}' -m 30 "$API/api/v1/$1" -H "x-user-id: $U" -H "x-company-id: $C"; }

# ---- fixtures ---------------------------------------------------------------
# UBL with prefixes unlike the usual cac:/cbc:, two VAT rates, entities, CDATA
cat > "$D/ubl.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment before the root -->
<u:Invoice xmlns:u="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
           xmlns:a="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
           xmlns:b="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <b:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</b:CustomizationID>
  <b:ID>PM-$TAG-1</b:ID>
  <b:IssueDate>2026-09-14</b:IssueDate>
  <b:DueDate>2026-10-14</b:DueDate>
  <b:InvoiceTypeCode>380</b:InvoiceTypeCode>
  <b:Note>Vielen Dank f&#252;r Ihren Auftrag &amp; bis bald.</b:Note>
  <b:DocumentCurrencyCode>EUR</b:DocumentCurrencyCode>
  <a:OrderReference><b:ID>BEST-77</b:ID></a:OrderReference>
  <a:AccountingSupplierParty><a:Party>
    <a:PartyName><b:Name>Papier Müller</b:Name></a:PartyName>
    <a:PostalAddress><b:StreetName>Lindenallee 12</b:StreetName><b:CityName>Leipzig</b:CityName><b:PostalZone>04109</b:PostalZone><a:Country><b:IdentificationCode>DE</b:IdentificationCode></a:Country></a:PostalAddress>
    <a:PartyTaxScheme><b:CompanyID>DE 811 907 980</b:CompanyID><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:PartyTaxScheme>
    <a:PartyTaxScheme><b:CompanyID>232/5718/1234</b:CompanyID><a:TaxScheme><b:ID>FC</b:ID></a:TaxScheme></a:PartyTaxScheme>
    <a:PartyLegalEntity><b:RegistrationName>Papier Müller $TAG GmbH</b:RegistrationName></a:PartyLegalEntity>
    <a:Contact><b:Name>Erika Müller</b:Name><b:ElectronicMail>buchhaltung@papier-mueller.example</b:ElectronicMail></a:Contact>
  </a:Party></a:AccountingSupplierParty>
  <a:AccountingCustomerParty><a:Party>
    <a:PostalAddress><b:CityName>Berlin</b:CityName><b:PostalZone>10115</b:PostalZone><a:Country><b:IdentificationCode>DE</b:IdentificationCode></a:Country></a:PostalAddress>
    <a:PartyLegalEntity><b:RegistrationName>$BUYER</b:RegistrationName></a:PartyLegalEntity>
  </a:Party></a:AccountingCustomerParty>
  <a:PaymentMeans><b:PaymentMeansCode>58</b:PaymentMeansCode><b:PaymentID>PM-$TAG-1</b:PaymentID>
    <a:PayeeFinancialAccount><b:ID>DE89 3704 0044 0532 0130 00</b:ID><a:FinancialInstitutionBranch><b:ID>COBADEFFXXX</b:ID></a:FinancialInstitutionBranch></a:PayeeFinancialAccount>
  </a:PaymentMeans>
  <a:PaymentTerms><b:Note>30 Tage netto</b:Note></a:PaymentTerms>
  <a:TaxTotal><b:TaxAmount currencyID="EUR">45.50</b:TaxAmount>
    <a:TaxSubtotal><b:TaxableAmount currencyID="EUR">200.00</b:TaxableAmount><b:TaxAmount currencyID="EUR">38.00</b:TaxAmount><a:TaxCategory><b:ID>S</b:ID><b:Percent>19</b:Percent><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:TaxCategory></a:TaxSubtotal>
    <a:TaxSubtotal><b:TaxableAmount currencyID="EUR">107.14</b:TaxableAmount><b:TaxAmount currencyID="EUR">7.50</b:TaxAmount><a:TaxCategory><b:ID>S</b:ID><b:Percent>7.00</b:Percent><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:TaxCategory></a:TaxSubtotal>
  </a:TaxTotal>
  <a:LegalMonetaryTotal><b:LineExtensionAmount currencyID="EUR">307.14</b:LineExtensionAmount><b:TaxExclusiveAmount currencyID="EUR">307.14</b:TaxExclusiveAmount><b:TaxInclusiveAmount currencyID="EUR">352.64</b:TaxInclusiveAmount><b:PayableAmount currencyID="EUR">352.64</b:PayableAmount></a:LegalMonetaryTotal>
  <a:InvoiceLine><b:ID>1</b:ID><b:InvoicedQuantity unitCode="C62">40</b:InvoicedQuantity><b:LineExtensionAmount currencyID="EUR">200.00</b:LineExtensionAmount>
    <a:Item><b:Name>Kopierpapier A4 &lt;500 Blatt&gt;</b:Name><a:ClassifiedTaxCategory><b:ID>S</b:ID><b:Percent>19</b:Percent><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:ClassifiedTaxCategory></a:Item>
    <a:Price><b:PriceAmount currencyID="EUR">5.00</b:PriceAmount></a:Price></a:InvoiceLine>
  <a:InvoiceLine><b:ID>2</b:ID><b:InvoicedQuantity unitCode="C62">3</b:InvoicedQuantity><b:LineExtensionAmount currencyID="EUR">107.14</b:LineExtensionAmount>
    <a:Item><b:Name><![CDATA[Fachbuch "Buchführung & Bilanz"]]></b:Name><a:ClassifiedTaxCategory><b:ID>S</b:ID><b:Percent>7</b:Percent><a:TaxScheme><b:ID>VAT</b:ID></a:TaxScheme></a:ClassifiedTaxCategory></a:Item>
    <a:Price><b:PriceAmount currencyID="EUR">35.7133</b:PriceAmount></a:Price></a:InvoiceLine>
</u:Invoice>
EOF
# CII: a credit note (381) of an Austrian supplier, reverse charge
cat > "$D/cii-credit.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument><ram:ID>GS-$TAG-9</ram:ID><ram:TypeCode>381</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20260920</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument><ram:SpecifiedTradeProduct><ram:Name>Lizenz Rückerstattung</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>500.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent></ram:ApplicableTradeTax><ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>500.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>Alpen Software $TAG GmbH</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>1010</ram:PostcodeCode><ram:LineOne>Ring 1</ram:LineOne><ram:CityName>Wien</ram:CityName><ram:CountryID>AT</ram:CountryID></ram:PostalTradeAddress><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">ATU12345678</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>$BUYER</ram:Name><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">$OWN_VAT</ram:ID></ram:SpecifiedTaxRegistration></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax><ram:CalculatedAmount>0.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:ExemptionReason>Reverse charge</ram:ExemptionReason><ram:BasisAmount>500.00</ram:BasisAmount><ram:CategoryCode>AE</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>500.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>500.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">0.00</ram:TaxTotalAmount><ram:GrandTotalAmount>500.00</ram:GrandTotalAmount><ram:DuePayableAmount>500.00</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
      <ram:InvoiceReferencedDocument><ram:IssuerAssignedID>AS-2026-77</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
EOF
# variant SRC DST [old new]… — a copy of a fixture with some text replaced
variant() {
  python3 - "$@" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
pairs = sys.argv[3:]
for i in range(0, len(pairs), 2):
    assert pairs[i] in s, pairs[i]
    s = s.replace(pairs[i], pairs[i + 1])
open(sys.argv[2], 'w', encoding='utf-8').write(s)
PY
}

note "=== 1. XRechnung (UBL): what is in it ==="
N_EXP() { q "select count(*) from \"Expense\" where \"companyId\"='$C'"; }
assert_eq "preview: 200" "$(send preview "$D/ubl.xml")" "200"
assert_eq "…recognised as XRechnung 3.0, UBL" "$(out "d['eInvoice'], d['invoice']['profile'], d['invoice']['syntax'], d['source']")" "(True, 'XRechnung 3.0', 'ubl-invoice', 'xml')"
assert_eq "…number, date, due date" "$(out "d['invoice']['number'], d['invoice']['issueDate'], d['invoice']['dueDate']")" "('PM-$TAG-1', '2026-09-14', '2026-10-14')"
assert_eq "…seller: legal name, VAT ID without the spaces, tax number" "$(out "d['invoice']['seller']['name'], d['invoice']['seller']['vatId'], d['invoice']['seller']['taxNumber']")" "('Papier Müller $TAG GmbH', 'DE811907980', '232/5718/1234')"
assert_eq "…entities and CDATA are text" "$(out "d['invoice']['lines'][0]['name'] + ' | ' + d['invoice']['lines'][1]['name'] + ' | ' + d['invoice']['notes'][0]")" 'Kopierpapier A4 <500 Blatt> | Fachbuch "Buchführung & Bilanz" | Vielen Dank für Ihren Auftrag & bis bald.'
assert_eq "…IBAN without spaces, totals" "$(out "d['invoice']['payment']['iban'], d['invoice']['totals']['net'], d['invoice']['totals']['tax'], d['invoice']['totals']['gross']")" "('DE89370400440532013000', 307.14, 45.5, 352.64)"
assert_eq "…one expense per VAT rate" "$(out "[(e['netAmount'], e['vatAmount'], e['grossAmount'], e['vatRate']) for e in d['expenses']]")" "[(200, 38, 238, 0.19), (107.14, 7.5, 114.64, 0.07)]"
assert_eq "…addressed to this company, a new supplier, nothing in the way" "$(out "d['buyerMatches'], d['supplierWillBeCreated'], d['importable'], d['blocking'], d['duplicate']")" "(True, True, True, [], None)"
assert_eq "a preview writes nothing" "$(N_EXP)/$(q "select count(*) from \"Supplier\" where \"companyId\"='$C'")" "0/0"

note "=== 2. import: supplier, expenses, the file kept ==="
assert_eq "import: 201" "$(send import "$D/ubl.xml")" "201"
E1=$(out "d['expenseIds'][0]"); E2=$(out "d['expenseIds'][1]"); SUP=$(out "d['supplierId']")
assert_eq "…two expenses, the supplier created" "$(out "len(d['expenseIds']), d['supplierCreated']")" "(2, True)"
assert_eq "expense 1: 200 + 38 at 19 %" "$(q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||\"grossAmount\"::numeric(12,2)||'/'||\"vatRate\"::numeric(4,2)||'/'||\"invoiceNumber\"||'/'||\"invoiceDate\"::date from \"Expense\" where id='$E1'")" "200.00/38.00/238.00/0.19/PM-$TAG-1/2026-09-14"
assert_eq "expense 2: 107.14 + 7.50 at 7 %" "$(q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||\"vatRate\"::numeric(4,2) from \"Expense\" where id='$E2'")" "107.14/7.50/0.07"
assert_eq "…what it is and when it is due stand in the notes" "$(q "select notes like 'E-Rechnung XRechnung 3.0 (UBL)%' and notes like '%fällig 14.10.2026%' and notes like '%DE89370400440532013000%' from \"Expense\" where id='$E1'")" "t"
assert_eq "the supplier: VAT ID, address, bank account from the invoice" "$(q "select \"vatId\"||'/'||(address->>'city')||'/'||(\"bankInfo\"->>'iban')||'/'||(metadata->>'taxNumber') from \"Supplier\" where id='$SUP'")" "DE811907980/Leipzig/DE89370400440532013000/232/5718/1234"
ATT=$(q "select id from \"Attachment\" where \"entityId\"='$E1' and \"entityType\"='expense'")
assert_eq "each expense has the file as its Beleg" "$(q "select count(*)||'/'||min(\"mimeType\") from \"Attachment\" where \"entityId\" in ('$E1','$E2')")" "2/application/xml"
curl -s -o "$D/back.xml" -D "$D/hdr" "$API/api/v1/attachments/$ATT/file?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "…byte for byte what was received" "$(cmp -s "$D/ubl.xml" "$D/back.xml" && echo same || echo differ)" "same"
assert_eq "…its hash is on record" "$(q "select \"contentHash\" from \"Attachment\" where id='$ATT'")" "$(shasum -a 256 "$D/ubl.xml" | cut -d' ' -f1)"
assert_eq "an XML is a download, never shown in place, not to be sniffed" "$(tr -d '\r' < "$D/hdr" | grep -ic "^content-disposition: attachment\|^x-content-type-options: nosniff\|^content-type: application/xml")" "3"
assert_eq "its content is searchable text" "$(q "select \"ocrText\" like '%Kopierpapier%' and \"ocrText\" like '%PM-$TAG-1%' from \"Attachment\" where id='$ATT'")" "t"

note "=== 3. the same invoice twice ==="
assert_eq "the same file again: 409" "$(send import "$D/ubl.xml")" "409"
send preview "$D/ubl.xml" >/dev/null
assert_eq "…the preview says so" "$(out "d['duplicate']['reason'], d['duplicate']['expenseId'] == '$E1'")" "('file', True)"
variant "$D/ubl.xml" "$D/ubl-resent.xml" "<!-- a comment before the root -->" "<!-- sent a second time -->"
assert_eq "another file with the same number of the same supplier: 409" "$(send import "$D/ubl-resent.xml")" "409"
send preview "$D/ubl-resent.xml" >/dev/null
assert_eq "…recognised by the number, the supplier by the VAT ID" "$(out "d['duplicate']['reason'], d['supplier']['matchedBy'], d['supplierWillBeCreated']")" "('number', 'vatId', False)"
assert_eq "still two expenses, one supplier" "$(N_EXP)/$(q "select count(*) from \"Supplier\" where \"companyId\"='$C'")" "2/1"

note "=== 4. reading the kept invoice ==="
assert_eq "GET /expenses/:id/e-invoice: 200" "$(get "expenses/$E1/e-invoice?companyId=$C")" "200"
assert_eq "…the invoice with its lines" "$(out "d['eInvoice'], d['invoice']['number'], len(d['invoice']['lines']), d['originalName']")" "(True, 'PM-$TAG-1', 2, 'ubl.xml')"
HAND_BODY='{"description":"von Hand","invoiceDate":"2026-09-01","netAmount":10,"vatAmount":1.9,"grossAmount":11.9,"vatRate":0.19}'
HAND=$(curl -s -X POST "$API/api/v1/expenses?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$HAND_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
assert_eq "a hand-entered expense has none: 200, eInvoice false" "$(get "expenses/$HAND/e-invoice?companyId=$C")/$(out "d['eInvoice']")" "200/False"
assert_eq "another company cannot read it: 404" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/expenses/$E1/e-invoice?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC")" "404"
assert_eq "…and not without a login: 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/expenses/e-invoice/preview?companyId=$C" -F "file=@$D/ubl.xml")" "401"

note "=== 5. an invoice with another bank account ==="
variant "$D/ubl.xml" "$D/ubl-iban.xml" "PM-$TAG-1" "PM-$TAG-2" "DE89 3704 0044 0532 0130 00" "DE02 1203 0000 0000 2020 51"
send preview "$D/ubl-iban.xml" >/dev/null
assert_eq "the preview warns: the IBAN is not the supplier's" "$(out "d['ibanDiffers'], d['warnings'][0].startswith('Achtung: Die Rechnung nennt die IBAN DE02120300000000202051')")" "(True, True)"
assert_eq "import: 201" "$(send import "$D/ubl-iban.xml")" "201"
assert_eq "…the supplier's bank account is NOT changed" "$(q "select \"bankInfo\"->>'iban' from \"Supplier\" where id='$SUP'")" "DE89370400440532013000"

note "=== 6. ZUGFeRD: the invoice inside a PDF ==="
SBODY='{"vatId":"DE123456789","email":"info@absender.example","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
curl -s -o /dev/null -X PUT "$API/api/v1/companies/$SC?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC" -H "Content-Type: application/json" -d "$SBODY"
fixture_issuer "$SC" "DE123456789"
KBODY="{\"name\":\"$BUYER\",\"type\":\"business\",\"vatId\":\"$OWN_VAT\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"k@example.test\"}}"
K=$(curl -s -X POST "$API/api/v1/customers?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC" -H "Content-Type: application/json" -d "$KBODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
IBODY="{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Beratung im September\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":150,\"vatRate\":0.19}]}"
INV=$(curl -s -X POST "$API/api/v1/invoices?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC" -H "Content-Type: application/json" -d "$IBODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -o "$D/zugferd.pdf" "$API/api/v1/invoices/$INV/zugferd?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC"
# an ordinary PDF with nothing embedded (the app's own invoice PDFs all carry the XML)
python3 - "$D/plain.pdf" <<'PY'
import sys
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>"]
out = b"%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 4\n0000000000 65535 f \n" + b"".join(b"%010d 00000 n \n" % o for o in offs)
out += b"trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref
open(sys.argv[1], "wb").write(out)
PY
assert_eq "fixture: the sender's ZUGFeRD PDF and its plain PDF" "$(head -c 5 "$D/zugferd.pdf")/$(head -c 5 "$D/plain.pdf")" "%PDF-/%PDF-"
assert_eq "preview of the ZUGFeRD PDF: 200" "$(send preview "$D/zugferd.pdf")" "200"
assert_eq "…the embedded factur-x.xml is read (CII)" "$(out "d['eInvoice'], d['source'], d['embeddedFile'], d['invoice']['syntax']")" "(True, 'pdf', 'factur-x.xml', 'cii')"
assert_eq "…seller, buyer by VAT ID, 300 + 57" "$(out "d['invoice']['seller']['vatId'], d['buyerMatches'], d['invoice']['totals']['net'], d['invoice']['totals']['tax'], d['invoice']['totals']['gross'], d['invoice']['lines'][0]['name']")" "('DE123456789', True, 300, 57, 357, 'Beratung im September')"
assert_eq "import: 201" "$(send import "$D/zugferd.pdf")" "201"
EZ=$(out "d['expenseIds'][0]")
assert_eq "…the expense, and the PDF itself kept as its Beleg" "$(q "select e.\"grossAmount\"::numeric(12,2)||'/'||a.\"mimeType\"||'/'||a.size from \"Expense\" e join \"Attachment\" a on a.\"entityId\"=e.id where e.id='$EZ'")" "357.00/application/pdf/$(wc -c < "$D/zugferd.pdf" | tr -d ' ')"
assert_eq "…and readable again from the stored PDF" "$(get "expenses/$EZ/e-invoice?companyId=$C")/$(out "d['source'], d['invoice']['number'] is not None")" "200/('pdf', True)"
assert_eq "a PDF without an invoice inside: eInvoice false (it goes to OCR)" "$(send preview "$D/plain.pdf")/$(out "d['eInvoice']")" "200/False"
assert_eq "…importing it: 400" "$(send import "$D/plain.pdf")" "400"
assert_eq "the sender reading its own invoice: an outgoing invoice, not importable" "$(curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/expenses/e-invoice/import?companyId=$SC" -H "x-user-id: $SU" -H "x-company-id: $SC" -F "file=@$D/zugferd.pdf")/$(grep -c "Ausgangsrechnung" "$D/out")" "400/1"

note "=== 7. a credit note, reverse charge (CII) ==="
send preview "$D/cii-credit.xml" >/dev/null
assert_eq "preview: a credit note, § 13b, EN 16931" "$(out "d['invoice']['creditNote'], d['invoice']['typeCode'], d['expenses'][0]['isReverseCharge'], d['expenses'][0]['vatAmount'], d['invoice']['precedingInvoice'], d['invoice']['profile']")" "(True, '381', True, 0, 'AS-2026-77', 'EN 16931 (ZUGFeRD / Factur-X COMFORT)')"
assert_eq "import: 201" "$(send import "$D/cii-credit.xml")" "201"
EC=$(out "d['expenseIds'][0]")
assert_eq "…stored negative, flagged § 13b, the supplier in Austria" "$(q "select e.\"netAmount\"::numeric(12,2)||'/'||e.\"grossAmount\"::numeric(12,2)||'/'||e.\"isReverseCharge\"||'/'||(s.address->>'country')||'/'||s.\"vatId\" from \"Expense\" e join \"Supplier\" s on s.id=e.\"supplierId\" where e.id='$EC'")" "-500.00/-500.00/true/AT/ATU12345678"

note "=== 8. addressed to someone else; another currency ==="
variant "$D/ubl.xml" "$D/ubl-other.xml" "PM-$TAG-1" "PM-$TAG-3" "$BUYER" "Ganz Andere AG"
assert_eq "an invoice to another company: 409" "$(send import "$D/ubl-other.xml")" "409"
assert_eq "…confirmed: 201" "$(send import "$D/ubl-other.xml" -F "confirmRecipient=true")" "201"
variant "$D/ubl.xml" "$D/ubl-usd.xml" "PM-$TAG-1" "PM-$TAG-4" "<b:DocumentCurrencyCode>EUR" "<b:DocumentCurrencyCode>USD"
assert_eq "an invoice in USD without a rate: 400" "$(send import "$D/ubl-usd.xml")/$(grep -c "Umrechnungskurs" "$D/out")" "400/1"
assert_eq "…with 1 EUR = 1,25 USD: 201" "$(send import "$D/ubl-usd.xml" -F "exchangeRate=1,25")" "201"
EU=$(out "d['expenseIds'][0]")
assert_eq "…booked in euro: 160 + 30.40" "$(q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||(notes like '%352,64 USD%') from \"Expense\" where id='$EU'")" "160.00/30.40/true"

note "=== 9. files that are no invoice, or mean harm ==="
BEFORE=$(N_EXP)
refused() { # label file expected-text
  assert_eq "$1: 400" "$(send import "$2")/$(grep -c "$3" "$D/out")" "400/1"
}
printf '<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY x "boom"><!ENTITY y "&x;&x;&x;&x;&x;&x;&x;&x;">]>\n<a>&y;</a>\n' > "$D/doctype.xml"
refused "a DOCTYPE (entity definitions)" "$D/doctype.xml" "DOCTYPE"
printf '<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<a>&x;</a>\n' > "$D/xxe.xml"
refused "an external entity" "$D/xxe.xml" "DOCTYPE"
variant "$D/ubl.xml" "$D/broken.xml" "</b:IssueDate>" "</b:DueDate>"
refused "tags that do not match" "$D/broken.xml" "nicht wohlgeformt"
python3 -c "import sys;open(sys.argv[2],'w',encoding='utf-8').write(open(sys.argv[1],encoding='utf-8').read()[:900])" "$D/ubl.xml" "$D/cut.xml"
refused "a file cut off in the middle" "$D/cut.xml" "nicht wohlgeformt"
printf '<?xml version="1.0"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>\n' > "$D/camt.xml"
refused "another kind of XML (a bank statement)" "$D/camt.xml" "keine E-Rechnung"
printf '<?xml version="1.0"?>\n<rsm:CrossIndustryDocument xmlns:rsm="urn:ferd:CrossIndustryDocument:invoice:1p0"/>\n' > "$D/zf1.xml"
refused "ZUGFeRD 1.0" "$D/zf1.xml" "ZUGFeRD 1.0"
python3 -c "import sys;open(sys.argv[1],'w').write('<?xml version=\"1.0\"?>'+'<a>'*5000+'</a>'*5000)" "$D/deep.xml"
refused "5000 nested elements" "$D/deep.xml" "verschachtelt"
variant "$D/ubl.xml" "$D/sums.xml" "PM-$TAG-1" "PM-$TAG-5" '<b:TaxInclusiveAmount currencyID="EUR">352.64' '<b:TaxInclusiveAmount currencyID="EUR">999.99'
refused "totals that do not add up" "$D/sums.xml" "ergeben nicht den Bruttobetrag"
send preview "$D/sums.xml" >/dev/null
assert_eq "…the preview shows it and says why it cannot be imported" "$(out "d['importable'], len(d['blocking']) >= 1")" "(False, True)"
variant "$D/ubl.xml" "$D/future.xml" "PM-$TAG-1" "PM-$TAG-8" "<b:IssueDate>2026-09-14" "<b:IssueDate>2099-01-01"
refused "an invoice dated in the future" "$D/future.xml" "Zukunft"
send preview "$D/future.xml" >/dev/null
assert_eq "…which the preview already says" "$(out "d['importable'], any('Zukunft' in b for b in d['blocking'])")" "(False, True)"
variant "$D/ubl.xml" "$D/nonumber.xml" "<b:ID>PM-$TAG-1</b:ID>" ""
refused "no invoice number" "$D/nonumber.xml" "BT-1"
variant "$D/ubl.xml" "$D/baddate.xml" "PM-$TAG-1" "PM-$TAG-6" "<b:IssueDate>2026-09-14" "<b:IssueDate>2026-02-30"
refused "a date that does not exist" "$D/baddate.xml" "BT-2"
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))" "$D/pic.xml"
refused "a picture named .xml" "$D/pic.xml" "weder eine XML-Datei noch eine PDF-Datei"
printf '%%PDF-1.4\n%% not really\n' > "$D/broken.pdf"
assert_eq "a damaged PDF: no invoice in it, no crash" "$(send preview "$D/broken.pdf")/$(out "d['eInvoice']")" "200/False"
: > "$D/empty.xml"
assert_eq "an empty file: 400" "$(send import "$D/empty.xml")" "400"
assert_eq "no file at all: 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/expenses/e-invoice/import?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -F "x=1")" "400"
assert_eq "none of these created an expense" "$(N_EXP)" "$BEFORE"
assert_eq "…and the backend is still there" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/health")" "200"

note "=== 10. an XML as an ordinary attachment ==="
attach() { curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/attachments" -H "x-user-id: $U" -H "x-company-id: $C" -F "companyId=$C" -F "entityType=expense" -F "entityId=$HAND" -F "file=@$1"; }
assert_eq "an .xml can be attached to an expense (was: Dateityp nicht erlaubt)" "$(attach "$D/ubl-resent.xml")" "201"
assert_eq "…and that expense now shows its e-invoice" "$(get "expenses/$HAND/e-invoice?companyId=$C")/$(out "d['eInvoice']")" "200/True"
assert_eq "an .xml that is not markup: 400" "$(attach "$D/pic.xml")" "400"
printf '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(document.cookie)</script></body></html>\n' > "$D/script.xml"
assert_eq "an XHTML page with script, named .xml: stored…" "$(attach "$D/script.xml")" "201"
XA=$(out "d['id']")
curl -s -o /dev/null -D "$D/hdr" "$API/api/v1/attachments/$XA/file?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "…but only ever handed out as a download" "$(tr -d '\r' < "$D/hdr" | grep -ic "^content-disposition: attachment\|^x-content-type-options: nosniff")" "2"

note "=== 11. the official validator on a received file ==="
ST=$(send validate "$D/ubl.xml")
assert_eq "POST e-invoice/validate answers" "$ST/$(out "d['available'] in (True, False), d['profile']")" "200/(True, 'XRechnung 3.0')"
if [[ "$(out "d['available']")" == "True" ]]; then
  assert_eq "…with KoSIT installed: a verdict with its findings" "$(out "isinstance(d.get('valid'), bool), isinstance(d.get('errors'), list)")" "(True, True)"
else
  note "KoSIT is not installed here — the route says so instead of failing"
fi

note "=== 12. the same invoice from several requests at once ==="
# Measured before: six simultaneous POSTs of one supplier invoice → six rows
# (each had checked for a duplicate before any had written).
variant "$D/ubl.xml" "$D/ubl-race.xml" "PM-$TAG-1" "PM-$TAG-7"
for i in 1 2 3 4; do send import "$D/ubl-race.xml" > "$D/race.$i" & done; wait
assert_eq "one file imported four times at once: once 201, three times 409" "$(cat "$D"/race.[1-4] | tr -d '\n' | fold -w3 | sort | tr '\n' ' ')" "201 409 409 409 "
assert_eq "…booked once (two VAT rates → two expenses)" "$(q "select count(*) from \"Expense\" where \"companyId\"='$C' and \"invoiceNumber\"='PM-$TAG-7'")" "2"
for route in expenses ustva/expenses; do
  RB="{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"RACE-$route\",\"description\":\"gleichzeitig\",\"invoiceDate\":\"2026-09-01\",\"netAmount\":100,\"vatAmount\":19,\"grossAmount\":119,\"vatRate\":0.19}"
  for i in 1 2 3 4 5 6; do
    curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/v1/$route?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$RB" > "$D/hand.$i" &
  done; wait
  assert_eq "POST /$route six times at once: one row, the others 409" "$(q "select count(*) from \"Expense\" where \"companyId\"='$C' and \"invoiceNumber\"='RACE-$route'")/$(cat "$D"/hand.[1-6] | sort | uniq -c | tr -s ' ' | tr '\n' ',')" "1/ 1 201, 5 409,"
done
rm -rf "$D"
summary
