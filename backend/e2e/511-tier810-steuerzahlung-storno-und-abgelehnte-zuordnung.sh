#!/bin/bash
# Tier 810 — the review of Tiers 806–809: a rejected suggestion, the Storno of a tax payment
#
# Measured before:
#  1. a bank transaction with a rejected invoice suggestion could not be
#     booked at all — book-expense answered „hat bereits eine Zuordnung —
#     bitte zuerst ablehnen" although it was rejected, book-tax the same, and
#     the tax-payment suggestions left the transaction out;
#  2. the Storno of a tax payment booked from the bank (Tier 808) freed the
#     transaction and left the payment: the UStVA stayed paid, the
#     Sondervorauszahlung's UstPayment counted on (booked again: twice), the
#     GewSt expense was left as an open bill nobody owes.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-511-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier810-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111114
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body] [extra header]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-H "$4"} ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS GET "/api/v1/ustva/deadlines?companyId=$C"
TODAY=$(P "d['today']"); Y=${TODAY:0:4}
read -r MY MM < <(python3 -c "
import datetime as t
d = t.date.fromisoformat('$TODAY').replace(day=1) - t.timedelta(days=1)
print(d.year, d.month)")
YY=${MY:2:2}; M2=$(printf '%02d' "$MM")

# a customer invoice of 1 190 € last month, its UStVA saved as filed (190 €), and open ones of 59,50 € and 35,70 €
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Hauptstr. 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"}}"
CU=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CU\",\"issueDate\":\"$MY-$M2-02\",\"items\":[{\"description\":\"Leder\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=$MY&month=$MM"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
FILING=$(json_field "$BODY" id)
assert_eq "fixture: the UStVA $MM/$MY filed, 190 € to pay" "$(q "select status||' '||\"payableVat\"::numeric(10,2) from \"UStvaFiling\" where id='$FILING'")" "submitted 190.00"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CU\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Muster\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
# a supplier credit note of 35,70 € to be refunded
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CU\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Probe\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":30,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
GS=$(q "insert into \"Expense\" (id, \"companyId\", description, \"invoiceDate\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", status, \"updatedAt\")
        values (gen_random_uuid()::text, '$C', 'Gutschrift $TAG', '$TODAY', -30, 0.19, -5.70, -35.70, 'booked', now()) returning id" | head -1)

camt() { # entries "amount|CRDT/DBIT|purpose|name"…
  { echo '<?xml version="1.0" encoding="UTF-8"?><Document><BkToCstmrStmt><Stmt>'
    echo '<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>'
    for e in "$@"; do
      IFS='|' read -r amt ind txt name <<< "$e"
      local who=Cdtr; [[ $ind == CRDT ]] && who=Dbtr
      echo "<Ntry><Amt>$amt</Amt><Ccy>EUR</Ccy><CdtDbtInd>$ind</CdtDbtInd><BookgDt><Dt>$TODAY</Dt></BookgDt><ValDt><Dt>$TODAY</Dt></ValDt>"
      echo "<TxDtls><CdtTrxTxInf><RltdPties><$who><Nm>$name</Nm></$who></RltdPties><RmtInf><Ustrd>$txt</Ustrd></RmtInf></CdtTrxTxInf></TxDtls></Ntry>"
    done
    echo '</Stmt></BkToCstmrStmt></Document>'; } > "$TMP/st.xml"
}
camt "59.50|CRDT|Umsatzsteuer-Jahreserklaerung $((Y - 1)) Erstattung|Finanzamt Koeln-Altstadt" \
     "35.70|CRDT|Gutschrift $TAG|$TAG Kunde" \
     "300.00|DBIT|Sondervorauszahlung $((Y + 1))|Finanzamt Koeln-Altstadt" \
     "190.00|DBIT|STNR 214/5000/1234 UST $M2/$YY|Finanzamt Koeln-Altstadt" \
     "1000.00|DBIT|Gewerbesteuer Q4 $Y|Stadtkasse Koeln"
ST=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$TMP/st.xml;type=application/xml" -F "companyId=$C" -F "userId=$U" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[[ -n "$ST" ]] && pass "fixture: a statement of five transactions" || { fail "import"; summary; exit 1; }
txn() { q "select id from \"BankTransaction\" where \"statementId\"='$ST' and purpose like '$1%'"; }
TAX() { AS POST "/api/v1/bank-statements/$ST/transactions/$(txn "$1")/book-tax?companyId=$C" "$2"; }
VOUCHER() { q "select \"voucherId\" from \"BankTransaction\" where id='$(txn "$1")'"; }
SUGG() { AS GET "/api/v1/bank-statements/$ST/tax-payments?companyId=$C"; P "sorted(s['label'] for s in d['suggestions'])"; }

# ── the allocation: a Storno on the day of its payment, in either order ──
RULE=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const dues = [{ due: '2026-11-16', amount: 1000 }]
const r = (pays) => f.allocatePrepayments(dues, pays).get('2026-11-16')
console.log([r([{ day: '2026-11-06', amount: 1000 }, { day: '2026-11-06', amount: -1000 }]), r([{ day: '2026-11-06', amount: -1000 }, { day: '2026-11-06', amount: 1000 }])].join(','))
" 2>&1 | tail -1)
assert_eq "a payment and its Storno of one day leave the prepayment open, in either order (was: paid when the Storno came first)" "$RULE" "1000,1000"

# ── 1. a rejected suggestion ─────────────────────────────────────────────
AS POST "/api/v1/bank-statements/$ST/suggest?companyId=$C" '{"autoConfirmThreshold":0}'
REC_R=$(q "select id from \"BankReconciliation\" where \"bankTransactionId\"='$(txn Umsatzsteuer-Jahres)' and status='suggested'")
REC_G=$(q "select id from \"BankReconciliation\" where \"bankTransactionId\"='$(txn Gutschrift)' and status='suggested'")
assert_eq "fixture: both credits got an invoice suggestion of their amount" "$([[ -n $REC_R && -n $REC_G ]] && echo both)" "both"
assert_eq "…while suggested, the refund is not offered as a tax payment" "$(SUGG | grep -c "Jahreserklärung")" "0"
AS POST "/api/v1/bank-statements/reconciliations/$REC_R/reject?companyId=$C"
AS POST "/api/v1/bank-statements/reconciliations/$REC_G/reject?companyId=$C"
assert_eq "both rejected" "$(q "select string_agg(status, ',') from \"BankReconciliation\" where id in ('$REC_R','$REC_G')")" "rejected,rejected"
assert_eq "rejected: the refund is offered (was: left out)" "$(SUGG | grep -c "Umsatzsteuer $((Y - 1)) (Jahreserklärung)")" "1"
TAX "Umsatzsteuer-Jahres" "{\"kind\":\"ustja\",\"year\":$((Y - 1))}"
assert_eq "…and booked (was 400 „hat bereits eine Zuordnung“)" "$STATUS/$(q "select amount from \"UstPayment\" where \"companyId\"='$C' and kind='ustja'")" "201/-59.50"
AS POST "/api/v1/bank-statements/$ST/transactions/$(txn Gutschrift)/book-expense?companyId=$C" "{\"expenseId\":\"$GS\"}"
assert_eq "the credit note's refund after a rejected suggestion: booked (was 400)" "$STATUS" "201"

# ── 2. the Storno of a tax payment ───────────────────────────────────────
svz() { q "select coalesce(sum(amount), 0) from \"UstPayment\" where \"companyId\"='$C' and kind='sondervorauszahlung' and year=$((Y + 1))"; }
TAX "Sondervorauszahlung" "{\"kind\":\"svz\",\"year\":$((Y + 1))}"
V=$(VOUCHER Sondervorauszahlung)
assert_eq "fixture: the Sondervorauszahlung booked" "$STATUS/$(svz)" "201/300.00"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{}'
assert_eq "its Storno: the UstPayment gets its counter-entry, dated today (was: still 300 €)" \
  "$STATUS/$(svz)/$(q "select to_char(\"paidAt\",'YYYY-MM-DD') from \"UstPayment\" where \"companyId\"='$C' and amount < 0 and kind='sondervorauszahlung'")" "201/0.00/$TODAY"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{}'
assert_eq "…a second Storno writes no second one" "$(svz)" "0.00"
TAX "Sondervorauszahlung" "{\"kind\":\"svz\",\"year\":$((Y + 1))}"
assert_eq "…booked again: once (was 600 €)" "$STATUS/$(svz)" "201/300.00"

TAX "STNR" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}"
V=$(VOUCHER STNR)
assert_eq "fixture: the UStVA paid" "$STATUS/$(q "select to_char(\"paidAt\",'YYYY-MM-DD')||' '||\"paidAmount\" from \"UStvaFiling\" where id='$FILING'")" "201/$TODAY 190.00"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{}'
assert_eq "its Storno: the return is unpaid again (was: paid)" "$STATUS/$(q "select \"paidAt\" is null and \"paidAmount\" is null from \"UStvaFiling\" where id='$FILING'")" "201/t"
TAX "STNR" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}"
assert_eq "…booked again (was 400 „bereits eine Zahlung erfasst“)" "$STATUS" "201"

AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$Y,\"q1\":1000,\"q2\":1000,\"q3\":1000,\"q4\":1000}"
TAX "Gewerbesteuer" "{\"kind\":\"gewst\",\"year\":$Y,\"quarter\":4}"
E=$(P "d['expenseId']"); V=$(VOUCHER Gewerbesteuer)
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "fixture: the GewSt Q4 paid by the bank" \
  "$(P "[x['status'] for x in d['deadlines'] if x['kind'] == 'gewst' and x['year'] == $Y and x['quarter'] == 4]")" "['filed']"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{}'
assert_eq "the Storno of a GewSt prepayment: its expense gets the counter-entry, it stays paid (was: an open bill)" \
  "$STATUS/$(q "select \"grossAmount\"::numeric(10,2) from \"Expense\" where \"reversesExpenseId\"='$E'")/$(q "select \"paidAt\" is not null from \"Expense\" where id='$E'")" "201/-1000.00/t"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "…and the deadline counts nothing paid for Q4" \
  "$(P "[x['status'] for x in d['deadlines'] if x['kind'] == 'gewst' and x['year'] == $Y and x['quarter'] == 4]")" "['open']"

summary
