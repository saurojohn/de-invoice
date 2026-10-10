#!/bin/bash
# Tier 650 — the second matcher (POST /fints/auto-match) matches against what
# is open, pairs receipts only when they belong together, and takes the best
# invoice, not the first
#
# The statement import's matcher was repaired in Tier 639; this one, written
# for the FinTS sync and run over the same bank transactions, had the same
# faults and one of its own. Measured:
#   two receipts of 500 € and 690 € from two different payers, no invoice
#        number  → both "Summe 2 Buchungen = Rechnungsbetrag", confidence 95,
#        for a third customer's invoice of 1 190 €
#   595 € for an invoice of 595 € with 300 € paid → matched ("Betrag exakt")
#   a receipt naming invoice B, where invoice A has the same amount → matched
#        to whichever the database returned first
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-384-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
TODAY=$(TZ=Europe/Berlin date +%F)
ISSUED=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=5)).isoformat())")
customer() { # name → id (subshell: only the output)
  local resp; resp=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"name":"'"$1"'","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}')
  json_field "$resp" id
}
invoice() { # customer net → I, N
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$1'","issueDate":"'$ISSUED'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  N=$(json_field "$BODY" invoiceNumber)
}
# a statement imported, its transactions left unmatched — as after a FinTS sync
statement() { # file entries "amount|purpose|payer name|payer IBAN"…
  local f=$1; shift
  { echo '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>'
    echo '<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>'
    for e in "$@"; do
      IFS='|' read -r amt txt name iban <<< "$e"
      echo "<Ntry><Amt Ccy=\"EUR\">$amt</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>$TODAY</Dt></BookgDt><ValDt><Dt>$TODAY</Dt></ValDt>"
      echo "<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>$name</Nm></Dbtr><DbtrAcct><Id><IBAN>$iban</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>$txt</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>"
    done
    echo '</Stmt></BkToCstmrStmt></Document>'; } > "$f"
  curl -sS -o /dev/null -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
    -F "file=@$f;type=application/xml" -F "companyId=$C" -F "userId=$U"
}
match() { AS POST "/api/v1/fints/auto-match" '{"companyId":"'$C'"}'; }
# the suggestions of the receipts whose purpose begins with …: "invoice confidence" …
of() { q "select coalesce(string_agg(i.\"invoiceNumber\"||' '||r.confidence, ', ' order by i.\"invoiceNumber\", t.amount), 'none')
  from \"BankReconciliation\" r join \"BankTransaction\" t on t.id=r.\"bankTransactionId\" join \"Invoice\" i on i.id=r.\"invoiceId\"
  where t.\"companyId\"='$C' and t.purpose like '$1%'"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier650-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
K1=$(customer "Dritte Firma GmbH"); K2=$(customer "Ratenzahler AG"); K3=$(customer "Teilzahler KG"); K4=$(customer "Zwillinge OHG")
invoice "$K1" 1000; N1=$N                      # 1 190 €, nobody pays it
invoice "$K2" 2000; N2=$N                      # 2 380 €, paid in two transfers that name it
invoice "$K2" 500;  N3=$N                      #   595 €, paid in two transfers from the customer's account, no number
invoice "$K3" 500;  P=$I; N4=$N                #   595 €, 300 € of it paid already
AS POST "/api/v1/invoices/$P/payments?companyId=$C" '{"amount":300,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
invoice "$K4" 100;  N5=$N                      #   119 €
invoice "$K4" 100;  N6=$N                      #   119 € — the one the receipt names
assert_eq "fixture: six open invoices, one of them partly paid" "$(q "select count(*) from \"Invoice\" where \"companyId\"='$C' and status='sent'")" "6"

statement "$TMP/a.xml" \
  "500.00|Fremd eins Abschlag|Erste Fremde GmbH|DE11111111111111111111" \
  "690.00|Fremd zwei Abschlag|Zweite Fremde GmbH|DE22222222222222222222" \
  "1380.00|Rate A zu $N2|Ratenzahler AG|DE33333333333333333333" \
  "1000.00|Rate B zu $N2|Ratenzahler AG|DE33333333333333333333" \
  "400.00|Ueberweisung eins|Ratenzahler AG|DE33333333333333333333" \
  "195.00|Ueberweisung zwei|Ratenzahler AG|DE33333333333333333333" \
  "595.00|Voll ohne Nummer|Teilzahler KG|DE44444444444444444444" \
  "295.00|Rest ohne Nummer|Teilzahler KG|DE44444444444444444444" \
  "119.00|Genau $N6|Zwillinge OHG|DE55555555555555555555"
assert_eq "fixture: nine receipts, none matched" "$(q "select count(*) from \"BankTransaction\" t where t.\"companyId\"='$C' and not exists (select 1 from \"BankReconciliation\" r where r.\"bankTransactionId\"=t.id)")" "9"

match
assert_eq "auto-match runs" "$STATUS" "201"
note "=== 1. receipts that do not belong together are not added up ==="
assert_eq "two strangers' 500 € and 690 € are nobody's 1 190 € (was: both 'Summe 2 Buchungen', 95, for $N1)" "$(of 'Fremd')" "none"
assert_eq "two transfers that name their invoice are its payment, together" "$(of 'Rate')" "$N2 95, $N2 95"
assert_eq "two transfers from one payer who is the invoice's customer, no number: together too" "$(of 'Ueberweisung')" "$N3 95, $N3 95"

note "=== 2. what is open, not the total ==="
assert_eq "595 € for an invoice of 595 € with 300 € paid: no match (was: 'Betrag exakt')" "$(of 'Voll')" "none"
assert_eq "its remaining 295 €: matched" "$(of 'Rest' | cut -d' ' -f1)" "$N4"

note "=== 3. the invoice the receipt names ==="
assert_eq "of two invoices over 119 €, the named one — with the number's confidence (was: whichever came first)" "$(of 'Genau')" "$N6 100"
assert_eq "…and nothing was proposed for the unpaid invoice of the third customer or the twin" \
  "$(q "select count(*) from \"BankReconciliation\" r join \"Invoice\" i on i.id=r.\"invoiceId\" where r.\"companyId\"='$C' and i.\"invoiceNumber\" in ('$N1','$N5')")" "0"
match
assert_eq "a second run adds nothing" "$(q "select count(*) from \"BankReconciliation\" where \"companyId\"='$C'")" "6"
summary
