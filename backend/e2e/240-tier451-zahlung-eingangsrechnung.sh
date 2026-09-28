#!/bin/bash
# Tier 451 — a bank debit pays a recorded expense only once, and only its amount
#
# Measured before: book-expense with an expenseId checked only that the
# expense belongs to the company. A debit of 119 was booked against an
# invoice of 1 190 and marked it paid; an expense already paid from the cash
# book or by an earlier bank booking was paid a second time; a supplier
# credit note was "paid" by a debit. Each wrote a voucher tagged with the
# expense — cost and Vorsteuer lines from the request, the expense itself
# unchanged or wrongly settled.
#
# Now a debit against an expense needs the expense's gross amount (±½ cent),
# refuses a credit note (its refund is an incoming payment, Tier 450), an AfA
# row, and an expense already paid from the cash book or by another bank
# booking. An expense paid by a SEPA batch is accepted: the debit is that
# batch's execution (Tier 432/433), and its paidAt stays the batch's.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-240-$(date +%s%N | cut -c1-13)"
Y=2026
TODAY=$(date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier451-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
paid() { AS GET "/api/v1/expenses/$1?companyId=$C"; py 'print((d.get("paidAt") or "-")[:10])'; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
expense() { # number net [creditNote]
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1'","invoiceDate":"'$Y'-06-01","netAmount":'$2',"vatRate":0.19,"vatAmount":'$(python3 -c "print(round($2*0.19,2))")',"grossAmount":'$(python3 -c "print(round($2*1.19,2))")${3:+,\"creditNote\":true}'}'
  json_field "$BODY" id
}
GROSS=$(expense ER-GROSS 1000)
BAR=$(expense ER-BAR 100)
TWICE=$(expense ER-TWICE 100)
GS=$(expense GS-1 100 cn)
SEPA=$(expense ER-SEPA 100)
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"eroeffnung","description":"Anfangsbestand","amount":500}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"ausgabe","description":"bar","amount":119,"vatRate":0.19,"expenseId":"'$BAR'"}'
AS POST "/api/v1/payments/batches" '{"companyId":"'$C'","expenseIds":["'$SEPA'"],"executionDate":"'$Y'-06-03","debtorIban":"DE02120300000000202051","debtorName":"'$TAG' GmbH"}'

# Six debits of 119,00.
MT=/tmp/t451-$TAG.mt940
{
  printf '%s\n' ':1:F01BANKBICAXXX0000000000' ':20:ST451' ':25:DE89370400440532013000' ':28C:1/1' ':60F:C260601EUR5000,00'
  for d in 02 03 04 05 06 07; do printf '%s\n' ":61:26060${d#0}060${d#0}D119,00NTRFNONREF//Zahlung $d" 'Lieferant'; done
  printf '%s\n' ':62F:C260607EUR4286,00' '-'
} > "$MT"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
mapfile -t T < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(t['id']) for t in sorted(d['transactions'],key=lambda t:t['valueDate']) if float(t['amount'])==-119]")
[[ ${#T[@]} -eq 6 ]] && pass "fixture: six debits imported" || fail "import: ${#T[@]} debits"
book() { AS POST "/api/v1/bank-statements/$SID/transactions/$1/book-expense?companyId=$C" '{"expenseId":"'$2'","vatRate":0.19,"vatAmount":19}'; }

note "=== refused ==="
book "${T[0]}" "$GROSS"
assert_eq "119 against an invoice of 1 190 (was 201, marked paid)" "$STATUS/$(paid "$GROSS")" "400/-"
book "${T[1]}" "$BAR"
assert_eq "an expense paid from the cash book (was 201: paid twice)" "$STATUS" "400"
book "${T[2]}" "$TWICE"
assert_eq "fixture: ER-TWICE paid by the bank" "$STATUS" "201"
book "${T[3]}" "$TWICE"
assert_eq "…and not a second time (was 201)" "$STATUS" "400"
book "${T[4]}" "$GS"
assert_eq "a credit note is not paid by a debit (was 201)" "$STATUS" "400"
AS GET "/api/v1/accounting/vouchers?companyId=$C"
assert_eq "only the one accepted booking wrote a voucher" \
  "$(py 'r=d if isinstance(d,list) else d.get("data",d.get("items",[]));print(len([v for v in r if v.get("referenceType")=="Expense"]))')" "1"

note "=== the debit of a SEPA batch ==="
book "${T[5]}" "$SEPA"
assert_eq "accepted: it is the batch's execution" "$STATUS" "201"
assert_eq "…paid as of the batch date" "$(paid "$SEPA")" "$Y-06-03"
AS POST "/api/v1/bank-statements/$SID/transactions/${T[0]}/book-expense?companyId=$C" '{}'
assert_eq "a refused debit can still be booked to an account" "$STATUS" "201"

summary
