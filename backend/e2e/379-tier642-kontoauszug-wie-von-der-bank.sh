#!/bin/bash
# Tier 642 — a bank statement as a bank writes it
#
# While reconciling the balance sheet's bank line, a CAMT.053 file was written
# to the ISO 20022 schema (camt.053.001.02 — <Amt Ccy="EUR">, the balance type
# in <Tp><CdOrPrtry><Cd>, the parties in <RltdPties>) instead of in the short
# form the specs use. Measured:
#   POST /bank-statements/preview → 0 transactions, no balances: the parser
#        read a format of its own (<Bal type="CLBD">, <Amt> without attribute).
#   A file with a block per booking day (MT940 ":20:", CAMT "<Stmt>") → the
#        first block only; the rest of the month was dropped without a word.
#   No import set the statement's period — and the balance sheet takes the
#        bank balance from the last statement *with* a period: "Kein
#        Kontoauszug importiert" after every import.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-379-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
upload() { # route file type → STATUS, BODY
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/$1?companyId=$C" \
    -F "file=@$2;type=$3" -F "companyId=$C" -F "userId=$U")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
day() { python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$1)).isoformat())"; }
swift() { python3 -c "print('$1'[2:4]+'$1'[5:7]+'$1'[8:10])"; }
D1=$(day 9); D2=$(day 8); D0=$(day 10)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier642-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Muster GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$D0'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'; INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'; NO=$(json_field "$BODY" invoiceNumber)
[[ -n "$NO" ]] && pass "fixture: an issued invoice over 1 190 €" || fail "fixture: $BODY"

# A file as a German bank delivers it: namespace, two statements (one per
# booking day), PRCD / CLBD balances, the amount's currency as an attribute,
# a batch entry of two payments, a pending entry, the parties by role.
cat > "$TMP/bank.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <BkToCstmrStmt>
  <GrpHdr><MsgId>53D0001</MsgId><CreDtTm>${D2}T20:00:00.0+02:00</CreDtTm></GrpHdr>
  <Stmt>
   <Id>0000000202051EUR00008</Id><ElctrncSeqNb>8</ElctrncSeqNb>
   <FrToDt><FrDtTm>${D1}T00:00:00.0+02:00</FrDtTm><ToDtTm>${D1}T23:59:59.9+02:00</ToDtTm></FrToDt>
   <Acct><Id><IBAN>DE02120300000000202051</IBAN></Id><Ccy>EUR</Ccy><Ownr><Nm>$TAG GmbH</Nm></Ownr>
    <Svcr><FinInstnId><BIC>BYLADEM1001</BIC><Nm>Deutsche Kreditbank Berlin</Nm></FinInstnId></Svcr></Acct>
   <Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">250.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>$D0</Dt></Dt></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">940.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>$D1</Dt></Dt></Bal>
   <Ntry>
    <Amt Ccy="EUR">1190.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>$D1</Dt></BookgDt><ValDt><Dt>$D1</Dt></ValDt><AcctSvcrRef>A1</AcctSvcrRef>
    <BkTxCd><Prtry><Cd>NTRF+166+00931</Cd><Issr>DK</Issr></Prtry></BkTxCd>
    <NtryDtls><TxDtls>
     <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
     <RltdPties><Dbtr><Nm>Muster GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>
      <Cdtr><Nm>$TAG GmbH</Nm></Cdtr><CdtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></CdtrAcct></RltdPties>
     <RmtInf><Ustrd>Rechnung $NO</Ustrd><Ustrd>Kd.-Nr. 4711 &amp; Dank</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
    <AddtlNtryInf>SEPA-Gutschrift</AddtlNtryInf>
   </Ntry>
  </Stmt>
  <Stmt>
   <Id>0000000202051EUR00009</Id><ElctrncSeqNb>9</ElctrncSeqNb>
   <FrToDt><FrDtTm>${D2}T00:00:00.0+02:00</FrDtTm><ToDtTm>${D2}T23:59:59.9+02:00</ToDtTm></FrToDt>
   <Acct><Id><IBAN>DE02120300000000202051</IBAN></Id><Ccy>EUR</Ccy></Acct>
   <Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">940.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>$D1</Dt></Dt></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1050.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>$D2</Dt></Dt></Bal>
   <Ntry>
    <Amt Ccy="EUR">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>$D2</Dt></BookgDt><ValDt><Dt>$D2</Dt></ValDt>
    <NtryDtls><TxDtls>
     <Refs><EndToEndId>MIETE-09</EndToEndId><MndtId>M-1</MndtId></Refs>
     <RltdPties><Dbtr><Nm>$TAG GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></DbtrAcct>
      <Cdtr><Nm>Vermieter GbR</Nm></Cdtr><CdtrAcct><Id><IBAN>DE75512108001245126199</IBAN></Id></CdtrAcct></RltdPties>
     <RmtInf><Ustrd>Miete</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
   <Ntry>
    <Amt Ccy="EUR">160.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>$D2</Dt></BookgDt><ValDt><Dt>$D2</Dt></ValDt>
    <NtryDtls><Btch><NbOfTxs>2</NbOfTxs></Btch>
     <TxDtls><Refs><EndToEndId>E-1</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">100.00</Amt></TxAmt></AmtDtls>
      <RltdPties><Dbtr><Nm>Kunde Eins</Nm></Dbtr><DbtrAcct><Id><IBAN>DE11111111111111111111</IBAN></Id></DbtrAcct></RltdPties>
      <RmtInf><Ustrd>Erste</Ustrd></RmtInf></TxDtls>
     <TxDtls><Refs><EndToEndId>E-2</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">60.00</Amt></TxAmt></AmtDtls>
      <RltdPties><Dbtr><Pty><Nm>Kunde Zwei</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>DE22222222222222222222</IBAN></Id></DbtrAcct></RltdPties>
      <RmtInf><Strd><CdtrRefInf><Ref>RF18539007547034</Ref></CdtrRefInf></Strd></RmtInf></TxDtls>
    </NtryDtls>
   </Ntry>
   <Ntry>
    <Amt Ccy="EUR">999.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts>
    <BookgDt><Dt>$D2</Dt></BookgDt><ValDt><Dt>$D2</Dt></ValDt>
    <NtryDtls><TxDtls><RmtInf><Ustrd>vorgemerkt</Ustrd></RmtInf></TxDtls></NtryDtls>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>
XML

note "=== 1. CAMT.053 as the schema has it ==="
upload preview "$TMP/bank.xml" application/xml
assert_eq "the preview reads it: four transactions of two days, the balances, their check (was: 0 transactions, no balance, 'unknown')" \
  "$STATUS $(field "d['totalTransactions'], d['openingBalance'], d['closingBalance'], d['totalCredit'], d['totalDebit'], d['balanceCheck']")" \
  "201 (4, '-250', '1050', '1350.00', '50.00', 'ok')"
upload import "$TMP/bank.xml" application/xml; ST=$(json_field "$BODY" id)
assert_eq "the import: the account, the bank, the period of both days" \
  "$STATUS $(field "d['accountIban'], d['bankName'], d['periodFrom'][:10], d['periodTo'][:10], d['openingBalance'], d['closingBalance']")" \
  "201 ('DE02120300000000202051', 'Deutsche Kreditbank Berlin', '$D1', '$D2', '-250', '1050')"
T() { q "select amount::numeric(10,2)||'|'||coalesce(\"counterpartyName\",'-')||'|'||coalesce(\"counterpartyIban\",'-')||'|'||coalesce(purpose,'-')||'|'||coalesce(\"endToEndId\",'-') from \"BankTransaction\" where \"statementId\"='$ST' and purpose like '$1%'"; }
assert_eq "a credit: who paid, both lines of the purpose, no 'NOTPROVIDED'" "$(T Rechnung)" "1190.00|Muster GmbH|DE89370400440532013000|Rechnung $NO Kd.-Nr. 4711 & Dank|-"
assert_eq "a debit: whom it went to, the reference" "$(T Miete)" "-50.00|Vermieter GbR|DE75512108001245126199|Miete|MIETE-09"
assert_eq "a batch entry: each payment of it, the second with its structured reference and the name under <Pty>" \
  "$(T Erste) / $(T RF18)" "100.00|Kunde Eins|DE11111111111111111111|Erste|E-1 / 60.00|Kunde Zwei|DE22222222222222222222|RF18539007547034|E-2"
assert_eq "the pending entry is not booked and not imported" "$(q "select count(*)||'/'||sum(amount)::numeric(10,2) from \"BankTransaction\" where \"statementId\"='$ST'")" "4/1300.00"
AS POST "/api/v1/bank-statements/$ST/suggest?companyId=$C" '{}'
assert_eq "…and the receipt finds its invoice" \
  "$(q "select i.\"invoiceNumber\"||' '||r.confidence from \"BankReconciliation\" r join \"Invoice\" i on i.id=r.\"invoiceId\" join \"BankTransaction\" t on t.id=r.\"bankTransactionId\" where t.\"statementId\"='$ST'")" "$NO 95"
upload import "$TMP/bank.xml" application/xml
assert_eq "the same file again: nothing new" "$STATUS" "409"
sed -e 's/<\([A-Za-z]\)/<ns2:\1/g' -e 's/<\/\([A-Za-z]\)/<\/ns2:\1/g' -e 's/<ns2:?xml/<?xml/' -e 's/xmlns=/xmlns:ns2=/' "$TMP/bank.xml" > "$TMP/prefixed.xml"
upload preview "$TMP/prefixed.xml" application/xml
assert_eq "the same file with a namespace prefix on every tag reads the same" "$STATUS $(field "d['totalTransactions'], d['closingBalance'], d['balanceCheck']")" "201 (4, '1050', 'ok')"

note "=== 2. the balance sheet's bank line ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$(TZ=Europe/Berlin date +%Y)"
assert_eq "1700 has the closing balance of the import (was: nicht ausgewiesen, 'Kein Kontoauszug importiert')" \
  "$STATUS $(echo "$BODY" | python3 -c "
import sys,json
def find(x):
    if isinstance(x,dict):
        if x.get('position')=='1700': yield x
        for v in x.values(): yield from find(v)
    elif isinstance(x,list):
        for v in x: yield from find(v)
print([l['amount'] for l in find(json.load(sys.stdin))])")" "200 [1050]"

note "=== 3. MT940 with a block per day ==="
{
  printf ':20:TAG1\n:25:10020030/1234567\n:28C:8/1\n:60F:C%sEUR100,00\n' "$(swift "$D0")"
  printf ':61:%sC40,00NTRFNONREF//A\n:86:166?00GUTSCHRIFT?20Erster Tag?32Kunde A\n' "$(swift "$D1")"
  printf ':62F:C%sEUR140,00\n-\n' "$(swift "$D1")"
  printf ':20:TAG2\n:25:10020030/1234567\n:28C:9/1\n:60F:C%sEUR140,00\n' "$(swift "$D1")"
  printf ':61:%sC60,00NTRFNONREF//B\n:86:166?00GUTSCHRIFT?20Zweiter Tag?32Kunde B\n' "$(swift "$D2")"
  printf ':61:%sD25,00NTRFNONREF//C\n:86:105?00LASTSCHRIFT?20Gebuehr\n' "$(swift "$D2")"
  printf ':62F:C%sEUR175,00\n-\n' "$(swift "$D2")"
} > "$TMP/two-days.sta"
upload import "$TMP/two-days.sta" text/plain; MT=$(json_field "$BODY" id)
assert_eq "both days are imported — three transactions, the first opening and the last closing balance, the period (was: the first day's one transaction, no period)" \
  "$STATUS $(field "d['openingBalance'], d['closingBalance'], d['periodFrom'][:10], d['periodTo'][:10]") $(q "select count(*)||'/'||sum(amount)::numeric(10,2) from \"BankTransaction\" where \"statementId\"='$MT'")" \
  "201 ('100', '175', '$D0', '$D2') 3/75.00"

note "=== 4. two accounts in one file ==="
sed -e 's/TAG2/TAG3/' -e '/^:20:TAG3/,$ s#10020030/1234567#10020030/7654321#' "$TMP/two-days.sta" > "$TMP/two-accounts.sta"
upload import "$TMP/two-accounts.sta" text/plain
assert_eq "refused, naming both (was: the first account imported, the other dropped)" \
  "$STATUS $(echo "$BODY" | grep -c 'von 2 Konten (10020030/1234567, 10020030/7654321)')" "400 1"
summary
