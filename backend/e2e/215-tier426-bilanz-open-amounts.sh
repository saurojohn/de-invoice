#!/bin/bash
# Tier 426 — the balance sheet shows what is actually open
#
# Measured before, on a 1 190 € invoice with 500 € paid, a second invoice paid
# only after the snapshot, one paid and one unpaid 119 € expense, a 200 €
# cash-book receipt, an imported statement with a 1 500 € closing balance and
# a customer credit of 150 € that had been used up:
#   1500 Forderungen              1190 — the totals of the invoices that are
#                                 "sent" today; the part payment ignored, the
#                                 invoice paid later missing entirely
#   1600+1700 liquide Mittel      200 — the cash book alone; the bank balance
#                                 nowhere, yet the line claimed to include it
#   4000 Verbindlichkeiten        238 — every booked expense, paid or not
#   4500 Kundenguthaben           150 — only the positive ledger rows are
#                                 summed, so a credit that was used stays
#   dashboard open receivables    1190, customer credit utilisation likewise
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-215-$(date +%s%N | cut -c1-13)"
YEAR=$(date +%Y); TODAY=$(date +%F)
NEXT=$((YEAR + 1))

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier426-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
# One balance-sheet line by its position.
LINE() { python3 - "$BODY" "$1" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
out = []
def walk(o):
    if isinstance(o, dict):
        if o.get('position') == sys.argv[2]: out.append(o['amount'])
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(d)
print(out[0] if out else '<no line>')
PY
}

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
# Tier 426: the Kreditlimit is accepted now — the credit-utilisation report
# read it, but no endpoint took it ("property creditLimit should not exist",
# 400) and the form had no field, so no customer could ever have one.
AS PUT "/api/v1/customers/$K?companyId=$C" '{"creditLimit":1000}'
assert_eq "a credit limit can be set (was 400)" "$STATUS" "200"
assert_eq "…and is stored" "$(q "select round(\"creditLimit\") from \"Customer\" where id='$K'")" "1000"
invoice() { # amount paymentAmount paymentDate → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$YEAR-03-01\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  [[ -n "$2" ]] && AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"
  echo "$id"
}
A=$(invoice 1000 500 "$YEAR-04-01")
B=$(invoice 100 119 "$NEXT-01-10")
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG L\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"}}"; S=$(json_field "$BODY" id)
expense() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$S\",\"invoiceNumber\":\"$1\",\"description\":\"$1\",\"invoiceDate\":\"$YEAR-05-01\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"; json_field "$BODY" id; }
EP=$(expense "ER-bezahlt"); expense "ER-offen" >/dev/null
q "update \"Expense\" set \"paidAt\"='$YEAR-06-01' where id='$EP'" >/dev/null
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$YEAR-02-01\",\"type\":\"einnahme\",\"description\":\"Barverkauf\",\"amount\":200,\"vatRate\":0.19}"
# A customer credit granted and used again — the ledger nets to zero.
q "insert into \"CustomerCreditTransaction\" (id, \"companyId\", \"customerId\", amount, \"balanceAfter\", type, description, \"createdAt\")
   values (gen_random_uuid()::text,'$C','$K',150,150,'overpayment','Guthaben','$YEAR-07-01'),
          (gen_random_uuid()::text,'$C','$K',-150,0,'usage','verrechnet','$YEAR-08-01')" >/dev/null

note "=== 1. Bilanz zum 31.12. ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$YEAR"
assert_eq "1500 Forderungen 809 = (1190 − 500) + 119 still open at year end (was 1190)" "$(LINE 1500)" "809"
assert_eq "1600 Kassenbestand 200" "$(LINE 1600)" "200"
assert_eq "1700 Bank: not known without a statement (was silently 0 inside one line)" "$(LINE 1700)" "None"
assert_eq "4000 Verbindlichkeiten 119 — the paid expense is gone (was 238)" "$(LINE 4000)" "119"
assert_eq "4500 Kundenguthaben 0 — the credit was used (was 150)" "$(LINE 4500)" "0"

note "=== 2. with an imported bank statement ==="
q "insert into \"BankStatement\" (id, \"companyId\", format, \"fileName\", \"fileSize\", \"accountIban\", \"periodFrom\", \"periodTo\", \"openingBalance\", \"closingBalance\", \"rawContent\", \"createdAt\")
   values (gen_random_uuid()::text,'$C','camt','a.xml',10,'DE02120300000000202051','$YEAR-11-01','$YEAR-11-30',0,1500,'','$YEAR-12-01'),
          (gen_random_uuid()::text,'$C','camt','b.xml',10,'DE02120300000000202051','$YEAR-12-01','$YEAR-12-31',1500,1700,'','$NEXT-01-02')" >/dev/null
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$YEAR"
assert_eq "1700 = the last statement's closing balance" "$(LINE 1700)" "1700"

note "=== 3. what the rest of the app calls open ==="
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard open receivables 690 (was 1190 — B is paid by now)" "$(P "d['openReceivables']")" "690"
AS GET "/api/v1/customers/credit-utilization?companyId=$C"
assert_eq "credit utilisation on the open 690 of a 1000 limit (was 1190 → 119 % 'over')" \
  "$(P "'%s/%s/%s' % (d[0]['totalOpen'], d[0]['utilization'], d[0]['status'])")" "690/69/ok"

summary; exit $?
