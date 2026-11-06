#!/bin/bash
# Tier 809 — a debit booked „Als Aufwand" reaches the reports
#
# Measured before: book-expense without an expense wrote a voucher (4900 an
# 1200, referenceType BankTransaction) and nothing else. The EÜR, the GuV, the
# UStVA and the BWA read expenses, so the debit was in the journal and in
# DATEV and in no report: the profit and the tax came out too high, and a
# Vorsteuer could not be booked at all (the UI sent no rate). Now:
#  1. the booking records an expense — dated and paid with the transaction,
#     on the chosen account, at the chosen rate (19 % / 7 % / none), with a
#     category — and the voucher pays it ([expense:<id>]);
#  2. a rate without a Vorsteuer account is refused before any write (was an
#     unbalanced voucher, „Soll und Haben müssen ausgeglichen sein");
#  3. two clicks at once book once (the booking was not under the
#     transaction's lock);
#  4. the voucher's Storno writes the expense's counter-entry, dated with the
#     Storno; the pair is locked;
#  5. a debit booked the old way (a voucher only) is taken into the expenses:
#     POST …/rebook-as-expense reverses it and books it again; a tax payment
#     on 1780 (Tier 808) is not such a booking.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-510-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier809-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
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
TODAY=$(P "d['today']"); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))

camt() { # entries "amount|purpose|name"…  (all debits, dated today)
  { echo '<?xml version="1.0" encoding="UTF-8"?><Document><BkToCstmrStmt><Stmt>'
    echo '<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>'
    for e in "$@"; do
      IFS='|' read -r amt txt name <<< "$e"
      echo "<Ntry><Amt>$amt</Amt><Ccy>EUR</Ccy><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>$TODAY</Dt></BookgDt><ValDt><Dt>$TODAY</Dt></ValDt>"
      echo "<TxDtls><CdtTrxTxInf><RltdPties><Cdtr><Nm>$name</Nm></Cdtr></RltdPties><RmtInf><Ustrd>$txt</Ustrd></RmtInf></CdtTrxTxInf></TxDtls></Ntry>"
    done
    echo '</Stmt></BkToCstmrStmt></Document>'; } > "$TMP/st.xml"
}
camt "119.00|Bueromaterial $TAG|Papier Schulz" \
     "12.50|Kontofuehrung $TAG|Sparkasse" \
     "30.00|Sonstiges $TAG|Irgendwer" \
     "45.00|Doppelklick $TAG|Tankstelle" \
     "50.00|Strom alt $TAG|Stadtwerke" \
     "300.00|Sondervorauszahlung $((Y + 1))|Finanzamt Koeln-Altstadt"
ST=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$TMP/st.xml;type=application/xml" -F "companyId=$C" -F "userId=$U" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[[ -n "$ST" ]] && pass "fixture: a statement of six debits" || { fail "import"; summary; exit 1; }
txn() { q "select id from \"BankTransaction\" where \"statementId\"='$ST' and purpose like '$1%'"; }
BOOK() { AS POST "/api/v1/bank-statements/$ST/transactions/$(txn "$1")/book-expense?companyId=$C" "$2" "${3:-}"; }
REBOOK() { AS POST "/api/v1/bank-statements/$ST/transactions/$(txn "$1")/rebook-as-expense?companyId=$C" "$2" "${3:-}"; }
EXP() { q "select \"netAmount\"::numeric(10,2)||' '||\"vatRate\"::numeric(4,2)||' '||\"vatAmount\"::numeric(10,2)||' '||\"grossAmount\"::numeric(10,2)||' '||coalesce(\"accountNumber\",'-')||' '||coalesce(category,'-')||' '||to_char(\"paidAt\",'YYYY-MM-DD')||' '||status from \"Expense\" where id='$1'"; }
LINES() { q "select string_agg(a.\"accountNumber\"||':'||vl.debit::numeric(10,2)||'/'||vl.credit::numeric(10,2), ',' order by a.\"accountNumber\") from \"VoucherLine\" vl join \"Account\" a on a.id=vl.\"accountId\" where vl.\"voucherId\"='$1'"; }
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"; VST0=$(P "round(d['vorsteuerSum'],2)")
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"; EUER0=$(P "round(d['totals']['ausgabenTotal'],2)")

# ── 1. the booking records the expense ───────────────────────────────────
BOOK "Bueromaterial" '{"expenseAccountNumber":"4930","vatRate":0.19,"category":"Bürobedarf"}' "x-readonly: 1"
assert_eq "read-only mode refuses the booking" "$STATUS" "403"
BOOK "Bueromaterial" '{"expenseAccountNumber":"4930","vatRate":0.19,"category":"Bürobedarf"}'
E1=$(P "d.get('createdExpenseId')"); V1=$(P "d['voucherId']")
assert_eq "booked at 19 %: an expense is recorded (was: a voucher only)" "$STATUS/$([[ $E1 =~ ^[0-9a-f-]{36}$ ]] && echo id)" "201/id"
assert_eq "…net, rate, VAT, gross, account, category, paid with the transaction" "$(EXP "$E1")" "100.00 0.19 19.00 119.00 4930 Bürobedarf $TODAY booked"
assert_eq "…the voucher pays it: Aufwand, Vorsteuer an Bank, tagged" \
  "$(LINES "$V1") $(q "select \"referenceType\"||' '||(description like '%[expense:$E1]%') from \"Voucher\" where id='$V1'")" \
  "1200:0.00/119.00,1576:19.00/0.00,4930:100.00/0.00 Expense true"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
assert_eq "the UStVA claims its Vorsteuer (was nothing)" "$(P "'%.2f' % (d['vorsteuerSum'] - $VST0)")" "19.00"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
# (in the EÜR the Vorsteuer paid is a Betriebsausgabe too: 100 cost + 19 Vorsteuer)
assert_eq "the EÜR counts it, cost and Vorsteuer paid (was nothing)" "$(P "'%.2f' % (d['totals']['ausgabenTotal'] - $EUER0)")" "119.00"

BOOK "Kontofuehrung" '{}'
E2=$(P "d.get('createdExpenseId')")
assert_eq "booked without a rate (the bank fee): no Vorsteuer, the default account" "$STATUS/$(EXP "$E2")" "201/12.50 0.00 0.00 12.50 4900 - $TODAY booked"
assert_eq "…the expense's text is the purpose" "$(q "select description from \"Expense\" where id='$E2'")" "Kontofuehrung $TAG"

# ── 2. a rate without a Vorsteuer account ────────────────────────────────
N0=$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")
BOOK "Sonstiges" '{"vatRate":0.16,"vatAmount":4.14}'
assert_eq "16 %: 400 before any write (was a 500 from an unbalanced voucher)" \
  "$STATUS/$(P "'19 % oder 7 %' in d['message']")/$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")/$(q "select \"voucherId\" is null from \"BankTransaction\" where id='$(txn Sonstiges)'")" \
  "400/True/$N0/t"

# ── 3. two clicks at once ────────────────────────────────────────────────
T4=$(txn "Doppelklick")
for i in 1 2 3; do
  curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$API/api/v1/bank-statements/$ST/transactions/$T4/book-expense?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d '{}' >> "$TMP/codes" &
done
wait
assert_eq "three at once: one booking (was three vouchers for one debit)" \
  "$(sort "$TMP/codes" | tr '\n' ' ')/$(q "select count(*) from \"Expense\" where \"companyId\"='$C' and notes like '%[bank-expense:$T4]%'")/$(q "select count(*) from \"Voucher\" where \"companyId\"='$C' and description like 'Doppelklick%'")" \
  "201 400 400 /1/1"

# ── 4. the Storno ────────────────────────────────────────────────────────
AS POST "/api/v1/accounting/vouchers/$V1/reversal?companyId=$C" '{"reason":"falsches Konto"}'
assert_eq "the voucher reversed" "$STATUS" "201"
assert_eq "…the expense gets its counter-entry, dated with the Storno (was: left as an open bill)" \
  "$(q "select \"grossAmount\"::numeric(10,2)||' '||\"vatAmount\"::numeric(10,2)||' '||to_char(\"invoiceDate\",'YYYY-MM-DD')||' '||to_char(\"paidAt\",'YYYY-MM-DD') from \"Expense\" where \"reversesExpenseId\"='$E1'")/$(q "select to_char(\"paidAt\",'YYYY-MM-DD') from \"Expense\" where id='$E1'")" \
  "-119.00 -19.00 $TODAY $TODAY/$TODAY"
assert_eq "…and the transaction is free again" "$(q "select \"voucherId\" is null from \"BankTransaction\" where id='$(txn Bueromaterial)'")" "t"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
assert_eq "…the UStVA nets it out" "$(P "'%.2f' % (d['vorsteuerSum'] - $VST0)")" "0.00"
AS DELETE "/api/v1/ustva/expenses/$E1?companyId=$C"
assert_eq "…the pair is locked: the expense is not deleted" "$STATUS/$(P "'stornierten Bankbeleg' in d['message']")" "400/True"
AS POST "/api/v1/accounting/vouchers/$V1/reversal?companyId=$C" '{}'
assert_eq "…a second Storno writes no second counter-entry" "$(q "select count(*) from \"Expense\" where \"reversesExpenseId\"='$E1'")" "1"
BOOK "Bueromaterial" '{"expenseAccountNumber":"4930","vatRate":0.19,"category":"Bürobedarf"}'
assert_eq "…booked again, correctly: a new expense" "$STATUS/$(P "d.get('createdExpenseId') not in (None, '$E1')")" "201/True"

# ── 5. a booking from before Tier 809 ────────────────────────────────────
T5=$(txn "Strom alt")
A4900=$(q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='4900'")
A1200=$(q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='1200'")
LV=$(q "insert into \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status)
        values (gen_random_uuid()::text, '$C', 'ALT-$TAG', '$TODAY', 'Strom alt $TAG', 'BankTransaction', 'posted') returning id" | head -1)
q "insert into \"VoucherLine\" (id, \"voucherId\", \"accountId\", description, debit, credit, \"sortOrder\") values
   (gen_random_uuid()::text, '$LV', '$A4900', 'Stadtwerke', 50, 0, 0), (gen_random_uuid()::text, '$LV', '$A1200', 'Bank Stadtwerke', 0, 50, 1);
   update \"BankTransaction\" set \"voucherId\"='$LV' where id='$T5'" >/dev/null
AS GET "/api/v1/bank-statements/$ST?companyId=$C"
assert_eq "fixture: booked the old way — the statement shows the voucher's type and its debit's account type" \
  "$(P "[(t['voucher']['referenceType'], [l['account']['type'] for l in t['voucher']['lines']]) for t in d['transactions'] if t['id'] == '$T5']")" \
  "[('BankTransaction', ['expense'])]"
REBOOK "Strom alt" '{"category":"Strom"}' "x-readonly: 1"
assert_eq "read-only mode refuses the rebooking" "$STATUS" "403"
REBOOK "Strom alt" '{"category":"Strom","vatRate":0.16}'
assert_eq "a rate that is not 19 / 7 / 0: 400" "$STATUS" "400"
REBOOK "Strom alt" '{"category":"Strom"}'
E5=$(P "d.get('createdExpenseId')"); V5=$(P "d['voucherId']")
assert_eq "POST …/rebook-as-expense (was 404): the old voucher reversed, booked again with its expense" \
  "$STATUS/$(q "select count(*) from \"Voucher\" where \"reversedById\"='$LV'")/$(EXP "$E5")/$(q "select \"voucherId\" from \"BankTransaction\" where id='$T5'")" \
  "201/1/50.00 0.00 0.00 50.00 4900 Strom $TODAY booked/$V5"
assert_eq "…the new voucher: the same account, an expense booking" "$(LINES "$V5") $(q "select \"referenceType\" from \"Voucher\" where id='$V5'")" "1200:0.00/50.00,4900:50.00/0.00 Expense"
REBOOK "Strom alt" '{}'
assert_eq "…a second time: 400" "$STATUS" "400"

AS POST "/api/v1/bank-statements/$ST/transactions/$(txn Sondervorauszahlung)/book-tax?companyId=$C" "{\"kind\":\"svz\",\"year\":$((Y + 1))}"
assert_eq "fixture: the Sondervorauszahlung booked as a tax payment (Tier 808)" "$STATUS" "201"
REBOOK "Sondervorauszahlung" '{}'
assert_eq "…a tax payment on 1780 is no booking to take into the expenses" "$STATUS/$(P "'keine Aufwandsbuchung' in d['message']")" "400/True"
BOOK "Kontofuehrung" '{}'
assert_eq "a debit booked the new way is not rebooked either" "$STATUS" "400"
REBOOK "Kontofuehrung" '{}'
assert_eq "…(rebook-as-expense: 400)" "$STATUS" "400"

# ── DATEV: each payment once, the Storno's counter-entry no second payment ──
curl -sS -o "$TMP/datev.csv" -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
# bank: 119 − 119 + 119 (Büromaterial, its Storno, again) + 12.50 + 45 + 50 − 50 + 50 (Strom, old and rebooked) + 300
assert_eq "DATEV: the bank pays 526.50 in all" "$(datev_balance "$TMP/datev.csv" 1200)" "-526.50"
assert_eq "…the Kreditor of the expenses is settled" "$(datev_balance "$TMP/datev.csv" 70000)" "0.00"
# (an expense goes to DATEV gross with its BU-Schlüssel — DATEV splits the Vorsteuer)
assert_eq "…4930 once, gross" "$(datev_balance "$TMP/datev.csv" 4930)" "119.00"
assert_eq "…4900: the fee, the fuel, the electricity once" "$(datev_balance "$TMP/datev.csv" 4900)" "107.50"

summary
