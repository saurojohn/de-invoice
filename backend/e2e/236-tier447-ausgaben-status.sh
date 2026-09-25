#!/bin/bash
# Tier 447 — the expenses list shows how an expense was paid, and what may be changed
#
# Measured before: GET /expenses derived each row's paymentState from bank-
# import vouchers alone ("[expense:<id>]" in the description):
#   - an expense paid by SEPA or from the cash book showed "offen" — the page's
#     "Offen" filter and counter listed bills that were paid;
#   - "storniert" could never appear: the Storno voucher's description is
#     "Storno: <number> …", without the tag, so it never matched — a reversed
#     bank booking showed "bezahlt" with the reversed voucher as its link.
# And the list carried no lockReason, so the page could not offer the edit of
# Tier 443 where it is allowed.
#
# Now paymentState is "bezahlt" when the expense is paid (paidAt — bank, SEPA,
# cash), "storniert" when it is open again after its bank booking was reversed
# (Tier 444), else "offen"; linkedVoucher is the booking that pays it (or the
# reversed one); lockReason comes from expense-lock.ts.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-236-$(date +%s%N | cut -c1-13)"
Y=2026
TODAY=$(date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier447-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
expense() { # number
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1'","invoiceDate":"'$Y'-06-01","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
  json_field "$BODY" id
}
OFFEN=$(expense ER-OFFEN)
SEPA=$(expense ER-SEPA)
BAR=$(expense ER-BAR)
BANK=$(expense ER-BANK)
STORNO=$(expense ER-STORNO)

AS POST "/api/v1/payments/batches" '{"companyId":"'$C'","expenseIds":["'$SEPA'"],"executionDate":"'$TODAY'","debtorIban":"DE02120300000000202051","debtorName":"'$TAG' GmbH"}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"eroeffnung","description":"Anfangsbestand","amount":500}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"ausgabe","description":"bar","amount":119,"vatRate":0.19,"expenseId":"'$BAR'"}'

MT=/tmp/t447-$TAG.mt940
cat > "$MT" <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST447
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR1000,00
:61:2606020602D119,00NTRFNONREF//Lieferant A
Lieferant
:61:2606030603D119,00NTRFNONREF//Lieferant B
Lieferant
:62F:C260603EUR762,00
-
EOF
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
read -r T1 T2 < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join(t['id'] for t in d['transactions'] if float(t['amount'])==-119))")
AS POST "/api/v1/bank-statements/$SID/transactions/$T1/book-expense?companyId=$C" '{"expenseId":"'$BANK'"}'
VBANK=$(json_field "$BODY" voucherId)
AS POST "/api/v1/bank-statements/$SID/transactions/$T2/book-expense?companyId=$C" '{"expenseId":"'$STORNO'"}'
VST=$(json_field "$BODY" voucherId)
AS POST "/api/v1/accounting/vouchers/$VST/reversal?companyId=$C" '{"reason":"falsch"}'
[[ "$STATUS" == 201 ]] && pass "fixture: one bank booking reversed" || fail "reversal: $STATUS"

note "=== GET /expenses ==="
AS GET "/api/v1/expenses?companyId=$C"
row() { py "r=[e for e in d['data'] if e['invoiceNumber']=='$1'][0];print($2)"; }
assert_eq "open: offen" "$(row ER-OFFEN 'r["paymentState"]')" "offen"
assert_eq "paid by SEPA: bezahlt (was offen)" "$(row ER-SEPA 'r["paymentState"]')" "bezahlt"
assert_eq "paid from the cash book: bezahlt (was offen)" "$(row ER-BAR 'r["paymentState"]')" "bezahlt"
assert_eq "paid by the bank: bezahlt, its voucher linked" "$(row ER-BANK 'r["paymentState"], r["linkedVoucher"]["id"]')" "bezahlt $VBANK"
assert_eq "bank booking reversed: storniert (was bezahlt)" "$(row ER-STORNO 'r["paymentState"]')" "storniert"
assert_eq "…linked to the reversed booking" "$(row ER-STORNO 'r["linkedVoucher"]["id"]')" "$VST"

note "=== what may be changed ==="
assert_eq "lockReason on the paid ones only (was absent)" \
  "$(py 'print(sorted((e["invoiceNumber"], bool(e.get("lockReason"))) for e in d["data"]))')" \
  "[('ER-BANK', True), ('ER-BAR', True), ('ER-OFFEN', False), ('ER-SEPA', True), ('ER-STORNO', False)]"
assert_eq "the SEPA reason names the storno" "$(row ER-SEPA '"SEPA" in r["lockReason"]')" "True"

summary
