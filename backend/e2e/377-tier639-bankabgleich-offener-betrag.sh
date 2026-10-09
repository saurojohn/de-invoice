#!/bin/bash
# Tier 639 — the bank statement is matched against what is open, and by the
# invoice number the customer wrote
#
# A statement reconciled by hand. Seven open invoices, eight lines. Measured:
#   "Rechnung INV-…-01", 1 190 €                 → suggested (95)
#   "INV-…-02 Teilzahlung", 300 of 595 €         → no suggestion, no candidate
#   "RE INV-…-03", 250 for 238 €                 → none
#   "INV-…-04 abzgl. 2% Skonto", 349,86 of 357 € → none
#   "INV-…-05 und INV-…-06", 595 = 119 + 476 €   → suggested: INV-…-02, which
#        the purpose does not name and which happened to have a total of 595 €
#   and with 300 € paid on INV-…-02 (295 € open) it was still the candidate
#   for 595 € — the amount was compared with the invoice's total, and an
#   invoice was no candidate at any other amount, whatever the purpose said.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-377-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
invoice() { # customer net [extra json] → I, N (number), issued
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$1'","issueDate":"'$ISSUED'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]'"${3:+,$3}"'}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  N=$(json_field "$BODY" invoiceNumber)
}
camt() { # file entries "amount|CRDT|date|purpose|name"…
  local f=$1; shift
  { echo '<?xml version="1.0" encoding="UTF-8"?><Document><BkToCstmrStmt><Stmt>'
    echo '<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>'
    for e in "$@"; do
      IFS='|' read -r amt ind dt txt name <<< "$e"
      echo "<Ntry><Amt>$amt</Amt><Ccy>EUR</Ccy><CdtDbtInd>$ind</CdtDbtInd><BookgDt><Dt>$dt</Dt></BookgDt><ValDt><Dt>$dt</Dt></ValDt>"
      echo "<TxDtls><CdtTrxTxInf><RltdPties><Dbtr><Nm>$name</Nm></Dbtr></RltdPties><RmtInf><Ustrd>$txt</Ustrd></RmtInf></CdtTrxTxInf></TxDtls></Ntry>"
    done
    echo '</Stmt></BkToCstmrStmt></Document>'; } > "$f"
}
import() { # file → ST (statement id), suggestions generated
  ST=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
    -F "file=@$1;type=application/xml" -F "companyId=$C" -F "userId=$U" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  AS POST "/api/v1/bank-statements/$ST/suggest?companyId=$C" '{}'
}
# the suggestions of a line, by the first words of its purpose: "number confidence applied" …
suggested() { q "select coalesce(string_agg(i.\"invoiceNumber\"||' '||r.confidence||' '||r.\"appliedAmount\"::numeric(10,2), ', ' order by i.\"invoiceNumber\"), 'none')
  from \"BankReconciliation\" r join \"BankTransaction\" t on t.id=r.\"bankTransactionId\" join \"Invoice\" i on i.id=r.\"invoiceId\"
  where t.\"statementId\"='$ST' and t.purpose like '$1%' and r.status='suggested'"; }
reason() { q "select r.\"matchReason\" from \"BankReconciliation\" r join \"BankTransaction\" t on t.id=r.\"bankTransactionId\" where t.\"statementId\"='$ST' and t.purpose like '$1%' order by r.\"createdAt\" limit 1"; }
txn() { q "select id from \"BankTransaction\" where \"statementId\"='$ST' and purpose like '$1%'"; }
state() { q "select status||' '||coalesce((select sum(amount) from \"Payment\" where \"invoiceId\"=i.id),0)::numeric(10,2) from \"Invoice\" i where id='$1'"; }
TODAY=$(TZ=Europe/Berlin date +%F)
ISSUED=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=5)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier639-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Muster GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Zweitkunde AG","type":"business","address":{"street":"Allee 9","postalCode":"20095","city":"Hamburg","country":"DE"}}'; K2=$(json_field "$BODY" id)
invoice "$K" 1000; R1=$I; N1=$N
invoice "$K" 500;  R2=$I; N2=$N
invoice "$K" 200;  R3=$I; N3=$N
invoice "$K" 300 '"skontoPercent":2,"skontoDays":14'; R4=$I; N4=$N
invoice "$K" 100;  R5=$I; N5=$N
invoice "$K" 400;  R6=$I; N6=$N
invoice "$K2" 250; R7=$I; N7=$N
assert_eq "fixture: seven issued invoices, 3 272,50 € open" "$(q "select count(*)||' '||sum(total)::numeric(10,2) from \"Invoice\" where \"companyId\"='$C' and status='sent'")" "7 3272.50"

note "=== 1. what is suggested ==="
camt "$TMP/a.xml" \
  "1190.00|CRDT|$TODAY|Rechnung $N1|Muster GmbH" \
  "300.00|CRDT|$TODAY|Teil $N2 Teilzahlung|Muster GmbH" \
  "250.00|CRDT|$TODAY|RE $N3|Muster GmbH" \
  "349.86|CRDT|$TODAY|Skonto $N4 abzgl. 2%|Muster GmbH" \
  "595.00|CRDT|$TODAY|Sammel $N5 und $N6|Muster GmbH" \
  "297.50|CRDT|$TODAY|Danke fuer die gute Arbeit|Zweitkunde AG" \
  "100.00|CRDT|$TODAY|Erstattung|Finanzamt"
import "$TMP/a.xml"
assert_eq "seven suggestions for six lines (was: three)" "$STATUS $(field "d['generated'], d['errors']")" "201 (7, 0)"
assert_eq "the amount and the number: as before" "$(suggested Rechnung)" "$N1 95 1190.00"
assert_eq "a part payment that names its invoice (was: none)" "$(suggested Teil) / $(reason Teil | cut -d+ -f1)" "$N2 60 300.00 / part payment "
assert_eq "more than is open, the invoice named: what is open of it (was: none)" "$(suggested RE) / $(reason RE | cut -d+ -f1)" "$N3 50 238.00 / more than is open "
assert_eq "the total less the invoice's Skonto (was: none)" "$(suggested Skonto) / $(reason Skonto | cut -d+ -f1)" "$N4 90 349.86 / amount less 2 % Skonto "
assert_eq "a transfer for two invoices: both, each with its amount (was: a third invoice with a total of 595 €)" "$(suggested Sammel)" "$N5 95 119.00, $N6 95 476.00"
assert_eq "no number, the amount and the name: as before" "$(suggested Danke)" "$N7 70 297.50"
assert_eq "a line nothing fits: none" "$(suggested Erstattung)" "none"

note "=== 2. confirmed ==="
for r in $(q "select r.id from \"BankReconciliation\" r join \"BankTransaction\" t on t.id=r.\"bankTransactionId\" where t.\"statementId\"='$ST' and r.status='suggested' order by r.\"createdAt\""); do
  AS POST "/api/v1/bank-statements/reconciliations/$r/confirm?companyId=$C"; CONF="${CONF:-}$STATUS "
done
assert_eq "all seven are confirmed" "$CONF" "201 201 201 201 201 201 201 "
assert_eq "paid in full: 1, 5, 6, 7" "$(state "$R1") | $(state "$R5") | $(state "$R6") | $(state "$R7")" "paid 1190.00 | paid 119.00 | paid 476.00 | paid 297.50"
assert_eq "the part payment leaves 295 € open" "$(state "$R2")" "sent 300.00"
assert_eq "the invoice paid with more: its 238 €, the other 12 € stay on the bank entry" \
  "$(state "$R3") / $(q "select (t.amount - sum(r.\"appliedAmount\"))::numeric(10,2) from \"BankTransaction\" t join \"BankReconciliation\" r on r.\"bankTransactionId\"=t.id and r.status='confirmed' where t.id='$(txn RE)' group by t.amount")" "paid 238.00 / 12.00"
assert_eq "the Skonto payment settles its invoice: 349,86 € and a credit note over 7,14 €" \
  "$(q "select status from \"Invoice\" where id='$R4'") $(q "select string_agg(amount::numeric(10,2)::text, '+' order by amount desc) from \"Payment\" where \"invoiceId\"='$R4'")" "paid 349.86+7.14"

note "=== 3. an invoice that is partly paid ==="
camt "$TMP/b.xml" \
  "595.00|CRDT|$TODAY|Zweite Zahlung ohne Nummer|Muster GmbH" \
  "295.00|CRDT|$TODAY|Rest $N2|Muster GmbH"
import "$TMP/b.xml"
assert_eq "595 € arrive, the invoice over 595 € has 295 € open: no candidate (was: that invoice, 'amount 60')" "$(suggested Zweite)" "none"
assert_eq "its rest, named: the amount fits what is open (was: no candidate — 295 is not the total)" "$(suggested Rest) / $(reason Rest | cut -d+ -f1)" "$N2 95 295.00 / amount 60 "
AS POST "/api/v1/bank-statements/$ST/transactions/$(txn Zweite)/match?companyId=$C" '{"invoiceId":"'$R2'"}'
assert_eq "the 595 € matched to it by hand take the 295 € that are open (was: 595 €)" "$STATUS $(field "d['appliedAmount']") $(state "$R2")" "201 295 paid 595.00"
AS GET "/api/v1/bank-statements/$ST/transactions/$(txn Zweite)/candidates?companyId=$C"
assert_eq "…and 300 € of the entry are left to match" "$(q "select (t.amount - sum(r.\"appliedAmount\"))::numeric(10,2) from \"BankTransaction\" t join \"BankReconciliation\" r on r.\"bankTransactionId\"=t.id and r.status='confirmed' where t.id='$(txn Zweite)' group by t.amount") $(field "len(d['candidates'])")" "300.00 0"

note "=== 4. the purpose names another invoice ==="
invoice "$K" 100; R8=$I; N8=$N
invoice "$K" 100; R9=$I; N9=$N
camt "$TMP/c.xml" "119.00|CRDT|$TODAY|Einzel $N9|Muster GmbH"
import "$TMP/c.xml"
AS GET "/api/v1/bank-statements/$ST/transactions/$(txn Einzel)/candidates?companyId=$C"
assert_eq "two invoices over 119 €, one named: that one first, the other 30 points lower and saying why" \
  "$(field "[(c['invoiceNumber'], c['confidence']) for c in d['candidates']], 'purpose names $N9' in d['candidates'][1]['matchReason']")" "([('$N9', 95), ('$N8', 40)], True)"
assert_eq "…and the candidates carry what is open and what would be applied" "$(field "d['candidates'][0]['openAmount'], d['candidates'][0]['appliedAmount'], d['candidates'][0]['total']")" "(119, 119, 119)"
summary
