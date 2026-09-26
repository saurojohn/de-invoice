#!/bin/bash
# Tier 450 — a supplier's refund is booked against its credit note
#
# Measured before: Tier 442 records a supplier credit note (negative amounts),
# but the money it promises could not be booked when it arrived. book-expense
# refused every incoming transaction ("nur für Ausgänge") and nothing else
# links an incoming payment to an expense. The credit note stayed open for
# good: the balance sheet showed the supplier owing us 238 after the refund
# was on the bank account, and the transaction stayed unbooked.
#
# Now book-expense takes an incoming transaction when `expenseId` names a
# credit note of the same amount: Bank an Aufwand / Vorsteuer (the lines of a
# payment, reversed), the credit note paid on the value date. Anything else
# incoming is still refused.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-239-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier450-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
owed() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"; py 'print([l["amount"] for s in d["passiva"] for l in s["lines"] if l.get("position")=="4000"][0])'; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-1","description":"Ware","invoiceDate":"'$Y'-06-01","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190}'
ER=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-1","description":"Retoure","invoiceDate":"'$Y'-06-05","netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238,"creditNote":true}'
GS=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-KLEIN","description":"Bonus","invoiceDate":"'$Y'-06-05","netAmount":50,"vatRate":0.19,"vatAmount":9.5,"grossAmount":59.5,"creditNote":true}'
GSK=$(json_field "$BODY" id)

MT=/tmp/t450-$TAG.mt940
cat > "$MT" <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST450
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR5000,00
:61:2606020602D1190,00NTRFNONREF//ER-1
Lieferant
:61:2606100610C238,00NTRFNONREF//Erstattung GS-1
Lieferant
:62F:C260610EUR4048,00
-
EOF
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
read -r TOUT TIN < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);t=d['transactions'];print([x['id'] for x in t if float(x['amount'])==-1190][0], [x['id'] for x in t if float(x['amount'])==238][0])")
AS POST "/api/v1/bank-statements/$SID/transactions/$TOUT/book-expense?companyId=$C" '{"expenseId":"'$ER'","vatRate":0.19,"vatAmount":190}'
assert_eq "fixture: the invoice paid by the bank" "$STATUS/$(paid "$ER")" "201/$Y-06-02"
assert_eq "fixture: before the refund the supplier owes us the credit note" "$(owed)" "-297.5"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=6"
VST=$(py 'print(round(d["vorsteuerSum"],2))')

note "=== what is still refused ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{}'
assert_eq "an incoming payment without a credit note" "$STATUS" "400"
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{"expenseId":"'$ER'"}'
assert_eq "…or against an invoice" "$STATUS" "400"
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{"expenseId":"'$GSK'"}'
assert_eq "…or against a credit note of another amount" "$STATUS" "400"

note "=== the refund against its credit note ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{"expenseId":"'$GS'","vatRate":0.19,"vatAmount":38}'
assert_eq "booked (was 400: nur für Ausgänge)" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
assert_eq "the credit note is settled on the value date" "$(paid "$GS")" "$Y-06-10"
assert_eq "owed: only the small credit note is left (was -297.5)" "$(owed)" "-59.5"
AS GET "/api/v1/accounting/vouchers/$V?companyId=$C"
assert_eq "Bank an Aufwand / Vorsteuer" \
  "$(py 'print(sorted((l["account"]["accountNumber"], float(l["debit"]), float(l["credit"])) for l in d["lines"]))')" \
  "[('1200', 238.0, 0.0), ('1576', 0.0, 38.0), ('4900', 0.0, 200.0)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=6"
assert_eq "the UStVA counts the credit note once: Vorsteuer unchanged by the refund" "$(py 'print(round(d["vorsteuerSum"],2))')" "$VST"
curl -sS -o /tmp/t450.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "DATEV: the Kreditor holds only the small credit note" "$(datev_balance /tmp/t450.csv 70001)" "59.50"
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{"expenseId":"'$GS'"}'
assert_eq "booked once" "$STATUS" "400"

note "=== its Storno takes the refund back (Tier 444) ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch"}'
assert_eq "Storno" "$STATUS" "201"
assert_eq "the credit note is open again" "$(paid "$GS")/$(owed)" "-/-297.5"
AS POST "/api/v1/bank-statements/$SID/transactions/$TIN/book-expense?companyId=$C" '{"expenseId":"'$GS'","vatRate":0.19,"vatAmount":38}'
assert_eq "…and the refund can be booked again" "$STATUS/$(paid "$GS")" "201/$Y-06-10"

note "=== a second incoming payment of the same amount (Tier 451) ==="
sed 's/ST450/ST450B/; s/2606100610C238/2606120612C238/' "$MT" > "$MT.b"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT.b;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID2=$(json_field "$UP" id)
TIN2=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['id'] for x in d['transactions'] if float(x['amount'])==238][0])")
AS POST "/api/v1/bank-statements/$SID2/transactions/$TIN2/book-expense?companyId=$C" '{"expenseId":"'$GS'","vatRate":0.19,"vatAmount":38}'
assert_eq "the credit note is not refunded twice" "$STATUS" "400"

summary
