#!/bin/bash
# Tier 577 — one bank debit pays an invoice entered as several expenses
#
# An Expense has one VAT rate. An invoice with 19 % and 7 % is therefore two
# expenses under the same supplier and number — entered by hand, or by the
# e-invoice import (Tier 573). The bank shows ONE payment. Measured before:
# book-expense with that debit → 400 "Die Abbuchung (352.64) entspricht nicht
# dem Betrag der Eingangsrechnung (238.00)" for either part; the invoice could
# not be settled through the bank import at all.
# Now the debit is accepted when it is exactly the sum of the supplier's open
# expenses with that number: one voucher (each part with its cost and
# Vorsteuer line), every part paid; a Storno frees all of them; DATEV exports
# one payment.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-348-$(date +%s%N | cut -c1-13)"
Y=2026
TODAY=$(date +%F)
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier577-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
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
expense() { # number net vat rate
  AS POST "/api/v1/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1' '$4'","invoiceDate":"'$Y'-06-01","netAmount":'$2',"vatAmount":'$3',"grossAmount":'$(python3 -c "print(round($2+$3,2))")',"vatRate":'$4',"confirmDuplicate":true}'
  json_field "$BODY" id
}
A19=$(expense ER-MIX 200 38 0.19)
A7=$(expense ER-MIX 107.14 7.50 0.07)
B19=$(expense ER-BAR 100 19 0.19)
B7=$(expense ER-BAR 100 7 0.07)
OTHER=$(expense ER-ANDERS 50 9.50 0.19)
[[ -n "$A19" && -n "$A7" && -n "$B19" && -n "$B7" && -n "$OTHER" ]] && pass "fixture: two invoices with 19 % and 7 % (two expenses each), one plain" || { fail "expenses: $BODY"; summary; exit 1; }
# ER-BAR's 19 % part is paid from the cash book
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"eroeffnung","description":"Anfangsbestand","amount":500}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"ausgabe","description":"bar","amount":119,"vatRate":0.19,"expenseId":"'$B19'"}'
assert_eq "fixture: ER-BAR's first part paid in cash" "$STATUS" "201"

MT=$(mktemp)
{
  printf '%s\n' ':1:F01BANKBICAXXX0000000000' ':20:ST577' ':25:DE89370400440532013000' ':28C:1/1' ':60F:C260601EUR5000,00'
  printf '%s\n' ':61:2606020602D300,00NTRFNONREF//weder noch' 'Lieferant'
  printf '%s\n' ':61:2606030603D352,64NTRFNONREF//ER-MIX' 'Lieferant'
  printf '%s\n' ':61:2606040604D352,64NTRFNONREF//ER-MIX noch einmal' 'Lieferant'
  printf '%s\n' ':61:2606050605D226,00NTRFNONREF//ER-BAR ganz' 'Lieferant'
  printf '%s\n' ':62F:C260605EUR3768,72' '-'
} > "$MT"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
T=(); while IFS= read -r line; do T+=("$line"); done < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(t['id']) for t in sorted(d['transactions'],key=lambda t:t['valueDate']) if float(t['amount'])<0]")
[[ ${#T[@]} -eq 4 ]] && pass "fixture: four debits imported" || { fail "import: ${#T[@]} debits — $UP"; summary; exit 1; }
# as the page sends it: the named part's own rate and VAT
book() { AS POST "/api/v1/bank-statements/$SID/transactions/$1/book-expense?companyId=$C" '{"expenseId":"'$2'","supplierId":"'$S'","vatRate":'$3',"vatAmount":'$4'}'; }

note "=== a debit that is neither a part nor the invoice ==="
book "${T[0]}" "$A19" 0.19 38
assert_eq "300,00 against ER-MIX: refused as before" "$STATUS/$(paid "$A19")/$(paid "$A7")" "400/-/-"

note "=== the debit of the whole invoice ==="
book "${T[1]}" "$A19" 0.19 38
assert_eq "352,64 against one part of ER-MIX (was 400: entspricht nicht dem Betrag)" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
assert_eq "…it says which expenses it paid" "$(py 'print(sorted(d.get("expenseIds") or []) == sorted(["'$A19'","'$A7'"]))')" "True"
assert_eq "both parts are paid on the value date" "$(paid "$A19")/$(paid "$A7")" "$Y-06-03/$Y-06-03"
assert_eq "the plain invoice is untouched" "$(paid "$OTHER")" "-"
AS GET "/api/v1/accounting/vouchers/$V?companyId=$C"
assert_eq "one voucher: each part's cost and Vorsteuer, one bank line — balanced" \
  "$(py 'L=d["lines"];f=lambda k:round(sum(float(l[k]) for l in L),2);print(len(L), f("debit"), f("credit"), sorted(round(float(l["vatAmount"]),2) for l in L if l.get("vatAmount") and float(l["vatAmount"])>0))')" "5 352.64 352.64 [7.5, 38.0]"
assert_eq "…tagged with both expenses" "$(py 'print(d["description"].count("[expense:"), "'$A19'" in d["description"], "'$A7'" in d["description"])')" "2 True True"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "the expense list shows both as paid, with that voucher" \
  "$(py 'print(sorted((e["paymentState"], (e.get("linkedVoucher") or {}).get("id")=="'$V'") for e in d["data"] if e["invoiceNumber"]=="ER-MIX"))')" "[('bezahlt', True), ('bezahlt', True)]"
book "${T[2]}" "$A7" 0.07 7.5
assert_eq "a second debit of the same amount: the invoice is paid, refused" "$STATUS" "400"

note "=== DATEV ==="
curl -sS -o "$MT.csv" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
KRED=$(datev_rows "$MT.csv" | awk -F'\t' '$1 ~ /ER-MIX/ || $2 ~ /ER-MIX/ { print ($3 ~ /^7/ ? $3 : $4) }' | sort -u | head -1)
assert_eq "one payment row for the invoice, of the whole amount" "$(datev_rows "$MT.csv" | awk -F'\t' -v k="$KRED" '$4 == k && $2 ~ /ER-MIX/ && $3 !~ /^7/ { n++; s += $5 } END { printf "%d %.2f\n", n, s }')" "1 352.64"
# the Kreditor still owes ER-BAR's 7 % part (107) and ER-ANDERS (59.50); ER-MIX is settled
assert_eq "the Kreditor's balance: ER-MIX settled (was 114,64 too much paid)" "$(datev_balance "$MT.csv" "$KRED")" "-166.50"

note "=== Storno frees every part ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch zugeordnet"}'
assert_eq "Storno" "$STATUS" "201"
assert_eq "both parts are open again" "$(paid "$A19")/$(paid "$A7")" "-/-"
book "${T[1]}" "$A7" 0.07 7.5
assert_eq "the debit can be booked again — naming the other part works the same" "$STATUS/$(paid "$A19")/$(paid "$A7")" "201/$Y-06-03/$Y-06-03"

note "=== a part that is already paid does not count ==="
book "${T[3]}" "$B7" 0.07 7
assert_eq "226,00 for ER-BAR whose 19 % part was paid in cash: refused" "$STATUS/$(paid "$B7")" "400/-"
rm -f "$MT" "$MT.csv"
summary
