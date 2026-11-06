#!/bin/bash
# Tier 808 — a tax payment in the bank statement, booked where the reports read it
#
# A debit to the Finanzamt or the municipality could only be booked „als
# Aufwand" — a voucher on 4900 that no report reads — and the payment had to
# be entered a second time (the UStVA's payment, a UstPayment, an expense
# „Gewerbesteuer") before the dashboard called the deadline paid. Now the bank
# page recognises the tax and its period (GET /bank-statements/:id/
# tax-payments) and books it (POST …/transactions/:txnId/book-tax): the
# return's payment or a UstPayment with a voucher Bank → 1780, or a KSt /
# GewSt expense (2200 / 4320) paid by the transaction.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-509-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# ── the recognition ───────────────────────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const g = require('./src/modules/bank-import/tax-payment')
const c = (n, p) => { const r = g.guessTaxPayment({ counterpartyName: n, purpose: p }); return r ? [r.kind, r.year, r.month ?? r.quarter].join(':') : 'none' }
console.log([
  c('Finanzamt Köln-Altstadt', 'STNR 214/5000/1234 UST 10/26'),
  c('FINANZKASSE KOELN', 'USt-VZ Okt 2026'),
  c('Finanzamt Berlin', 'UST 2026 43 StNr 12/345/67890'),
  c('Finanzamt Hamburg', 'Sondervorauszahlung 2027'),
  c('Finanzamt Hamburg', 'Umsatzsteuer-Jahreserklärung 2025 Abschlusszahlung'),
  c('Finanzamt München', 'KSt IV/2026 SolZ'),
  c('Stadtkasse Düsseldorf', 'GewSt VZ Q4 2026 Kassenzeichen 12345'),
  c('Stadt Neuss', 'Gewerbesteuer 2026 IV. Vj'),
  c('Lederhandel Müller GmbH', 'RE 2026-117 inkl. 19% USt'),
  c('Finanzamt Köln', 'Lohnsteuer 10/2026'),
  c('Finanzamt Köln', 'USt Zahlung 10.11.2026'),
  c('Finanzamt Köln', 'Steuerzahlung StNr 214/5000/1234'),
  c('Finanzamt Köln', 'Säumniszuschlag StNr 214/5000/1234'),
].join(','))
" 2>&1 | tail -1)
assert_eq "what a Finanzamt or a Kasse writes, and what it is not (a supplier's „inkl. USt\", the Lohnsteuer, a date)" "$RULES" \
  "ustva:2026:10,ustva:2026:10,ustva:2026:3,svz:2027:,ustja:2025:,kst:2026:4,gewst:2026:4,gewst:2026:4,none,none,ustva::,ustva::,none"

# ── a company with a UStVA filed, prepayments entered ─────────────────────
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier808-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111113
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
# the month of the return with nothing filed: three months before
read -r NY NM < <(python3 -c "
import datetime as t
d = t.date.fromisoformat('$TODAY').replace(day=1)
for _ in range(3): d = (d - t.timedelta(days=1)).replace(day=1)
print(d.year, d.month)")

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Hauptstr. 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"}}"
CU=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CU\",\"issueDate\":\"$MY-$M2-02\",\"items\":[{\"description\":\"Leder\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an invoice of 1 000 € + 190 € USt in $MM/$MY" "$STATUS" "200"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$MY&month=$MM"
UV=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$UV"
FILING=$(json_field "$BODY" id)
assert_eq "fixture: the UStVA $MM/$MY saved as submitted, 190 € to pay" "$(q "select status||' '||\"payableVat\"::numeric(10,2) from \"UStvaFiling\" where id='$FILING'")" "submitted 190.00"
for y in $((Y - 1)) $Y $((Y + 1)); do AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$y,\"q1\":1000,\"q2\":1000,\"q3\":1000,\"q4\":1000}"; done

# ── the statement ─────────────────────────────────────────────────────────
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
camt "190.00|DBIT|STNR 214/5000/1234 UST $M2/$YY|Finanzamt Köln-Altstadt" \
     "190.00|DBIT|Steuerzahlung StNr 214/5000/1234 $TAG|Finanzamt Köln-Altstadt" \
     "1000.00|DBIT|GewSt VZ Kassenzeichen 4711|Stadtkasse Köln" \
     "2500.50|DBIT|KSt IV/$Y SolZ|Finanzamt Köln-Altstadt" \
     "300.00|DBIT|Sondervorauszahlung $((Y + 1))|Finanzamt Köln-Altstadt" \
     "50.00|CRDT|Umsatzsteuer-Jahreserklaerung $((Y - 1)) Erstattung|Finanzamt Köln-Altstadt" \
     "119.00|DBIT|RE $Y-117 inkl. 19% USt|Lederhandel Müller GmbH" \
     "77.00|DBIT|UST $(printf '%02d' "$NM")/${NY:2:2}|Finanzamt Köln-Altstadt"
ST=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$TMP/st.xml;type=application/xml" -F "companyId=$C" -F "userId=$U" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[[ -n "$ST" ]] && pass "fixture: a statement of eight transactions" || { fail "import"; summary; exit 1; }
txn() { q "select id from \"BankTransaction\" where \"statementId\"='$ST' and purpose like '$1%'"; }
# the GewSt quarter due nearest to today
GQ=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const t = '$TODAY', c = []
for (const y of [$Y - 1, $Y, $Y + 1]) for (const q of [1, 2, 3, 4]) { const d = f.prepaymentDeadline('gewst', y, q, null); if (t >= f.addDaysIso(d, -45) && t <= f.addDaysIso(d, 60)) c.push([Math.abs(Date.parse(t) - Date.parse(d)), y, q, d]) }
c.sort((a, b) => a[0] - b[0]); console.log(c[0].slice(1).join(':'))
" 2>&1 | tail -1)
IFS=: read -r GY GQN GDUE <<<"$GQ"

AS GET "/api/v1/bank-statements/$ST/tax-payments?companyId=$C"
assert_eq "GET /bank-statements/:id/tax-payments (was 404)" "$STATUS" "200"
SUG() { P "sorted([(x['kind'], x['year'], x['month'] or x['quarter'], x['problem'], float(x['amount'])) for x in d['suggestions']], key=lambda s: (s[0], s[4]))"; }
assert_eq "recognised: the UStVA by its period and by its amount, the GewSt by its amount, KSt, Sondervorauszahlung, the annual refund; the supplier not; the month without a return flagged" \
  "$(SUG)" "[('gewst', $GY, $GQN, None, -1000.0), ('kst', $Y, 4, None, -2500.5), ('svz', $((Y + 1)), None, None, -300.0), ('ustja', $((Y - 1)), None, None, 50.0), ('ustva', $MY, $MM, None, -190.0), ('ustva', $MY, $MM, None, -190.0), ('ustva', $NY, $NM, 'no-filing', -77.0)]"

BOOK() { # purpose-prefix body [extra header]
  AS POST "/api/v1/bank-statements/$ST/transactions/$(txn "$1")/book-tax?companyId=$C" "$2" "${3:-}"
}
BOOK "STNR" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}" "x-readonly: 1"
assert_eq "read-only mode refuses the booking" "$STATUS" "403"
BOOK "STNR" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}"
MONTHNAME=$(python3 -c "print(['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'][$MM - 1])")
assert_eq "the UStVA payment booked" "$STATUS/$(P "d['label']")" "201/UStVA $MONTHNAME $MY"
assert_eq "…as the return's payment, on the day of the debit" "$(q "select \"paidAt\"::date||' '||\"paidAmount\" from \"UStvaFiling\" where id='$FILING'")" "$TODAY 190.00"
VOUCHER=$(q "select \"voucherId\" from \"BankTransaction\" where id='$(txn STNR)'")
assert_eq "…with the voucher Bank → USt-Vorauszahlungen" \
  "$(q "select string_agg(a.\"accountNumber\"||':'||l.debit::numeric(10,2)||'/'||l.credit::numeric(10,2), ' ' order by a.\"accountNumber\" collate \"C\") from \"VoucherLine\" l join \"Account\" a on a.id=l.\"accountId\" where l.\"voucherId\"='$VOUCHER'")" \
  "1200:0.00/190.00 1780:190.00/0.00"
BOOK "STNR" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}"
assert_eq "booked once only" "$STATUS" "400"
BOOK "Steuerzahlung" "{\"kind\":\"ustva\",\"year\":$MY,\"month\":$MM}"
assert_eq "a second payment for a return already paid: refused" "$STATUS/$(P "'bereits eine Zahlung' in d['message']")" "400/True"
BOOK "UST $(printf '%02d' "$NM")" "{\"kind\":\"ustva\",\"year\":$NY,\"month\":$NM}"
assert_eq "a UStVA not saved here: refused, with what to do" "$STATUS/$(P "'erst die Voranmeldung speichern' in d['message']")" "400/True"
BOOK "Umsatzsteuer-Jahres" "{\"kind\":\"kst\",\"year\":$Y,\"quarter\":4}"
assert_eq "a refund is no prepayment" "$STATUS" "400"

BOOK "GewSt VZ" "{\"kind\":\"gewst\",\"year\":$GY,\"quarter\":$GQN}"
assert_eq "the GewSt prepayment booked" "$STATUS" "201"
EXP=$(P "d['expenseId']")
assert_eq "…as an expense „Gewerbesteuer\" on 4320, paid on the day" \
  "$(q "select category||' '||\"grossAmount\"::numeric(10,2)||' '||\"accountNumber\"||' '||\"paidAt\"::date from \"Expense\" where id='$EXP'")" "Gewerbesteuer 1000.00 4320 $TODAY"
if [[ ! "$GDUE" < "$(python3 -c "import datetime as t;print(t.date.fromisoformat('$TODAY')-t.timedelta(days=30))")" ]]; then
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "…and the dashboard calls Q$GQN/$GY paid" "$(P "[x['status'] for x in d['deadlines'] if x['kind'] == 'gewst' and x['year'] == $GY and x['quarter'] == $GQN]")" "['filed']"
fi
BOOK "KSt IV" "{\"kind\":\"kst\",\"year\":$Y,\"quarter\":4}"
assert_eq "the KSt prepayment booked, on 2200" "$STATUS/$(q "select category||' '||\"accountNumber\" from \"Expense\" where id='$(P "d['expenseId']")'")" "201/Körperschaftsteuer 2200"
BOOK "Sondervorauszahlung" "{\"kind\":\"svz\",\"year\":$((Y + 1))}"
assert_eq "the Sondervorauszahlung booked as a UstPayment" "$STATUS/$(q "select kind||' '||year||' '||amount from \"UstPayment\" where id='$(P "d['ustPaymentId']")'")" "201/sondervorauszahlung $((Y + 1)) 300.00"
BOOK "Umsatzsteuer-Jahres" "{\"kind\":\"ustja\",\"year\":$((Y - 1))}"
assert_eq "the annual return's refund: a negative UstPayment" "$STATUS/$(q "select kind||' '||year||' '||amount from \"UstPayment\" where id='$(P "d['ustPaymentId']")'")" "201/ustja $((Y - 1)) -50.00"
VR=$(q "select \"voucherId\" from \"BankTransaction\" where id='$(txn Umsatzsteuer-Jahres)'")
assert_eq "…and its voucher the other way: Bank to 1780" \
  "$(q "select string_agg(a.\"accountNumber\"||':'||l.debit::numeric(10,2)||'/'||l.credit::numeric(10,2), ' ' order by a.\"accountNumber\" collate \"C\") from \"VoucherLine\" l join \"Account\" a on a.id=l.\"accountId\" where l.\"voucherId\"='$VR'")" \
  "1200:50.00/0.00 1780:0.00/50.00"

AS GET "/api/v1/bank-statements/$ST/tax-payments?companyId=$C"
assert_eq "what is booked is no longer suggested; the second 190 € matches no unpaid return now" "$(SUG)" "[('ustva', $NY, $NM, 'no-filing', -77.0)]"

summary
