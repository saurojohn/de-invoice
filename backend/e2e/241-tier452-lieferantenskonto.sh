#!/bin/bash
# Tier 452 — paying a supplier bill less its Skonto
#
# Measured before: a bill of 1 190 € paid within its Skonto period with
# 1 166,20 € (2 %) could not be booked against the bill — Tier 451 refuses a
# debit that is not the bill's amount (before Tier 451 it was booked and the
# bill marked paid, with the Skonto nowhere: cost 1 000 and Vorsteuer 190
# although 23,80 € were never paid). The way out was a supplier credit note
# for the difference entered by hand first.
#
# Now `skonto: true` books it: the difference (at most 10 % of the bill) becomes
# a supplier credit note split at the bill's rate (§ 17 UStG — net −20, VAT
# −3,80), settled with the payment, and the bill is paid. Cost 980, Vorsteuer
# 186,20, nothing owed in the balance sheet or DATEV. A Storno of the payment
# takes the Skonto back with it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-241-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier452-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
says() { grep -qF "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
paid() { AS GET "/api/v1/expenses/$1?companyId=$C"; py 'print((d.get("paidAt") or "-")[:10])'; }
owed() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"; py 'print([l["amount"] for s in d["passiva"] for l in s["lines"] if l.get("position")=="4000"][0])'; }
vorsteuer() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=6"; py 'print("%.2f" % d["vorsteuerSum"])'; }
skonti() { AS GET "/api/v1/expenses?companyId=$C"; py 'print([(e["invoiceNumber"], float(e["netAmount"]), float(e["vatAmount"]), (e.get("paidAt") or "-")[:10]) for e in d["data"] if float(e["grossAmount"])<0])'; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'
S=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-1","description":"Ware","invoiceDate":"'$Y'-06-01","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190,"category":"Material"}'
ER=$(json_field "$BODY" id)

MT=/tmp/t452-$TAG.mt940
cat > "$MT" <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST452
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR5000,00
:61:2606080608D1166,20NTRFNONREF//ER-1 abzgl. 2% Skonto
Lieferant
:61:2606090609D1000,00NTRFNONREF//zu wenig
Lieferant
:62F:C260609EUR2833,80
-
EOF
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
read -r TSK TLOW < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);t=d['transactions'];print([x['id'] for x in t if float(x['amount'])==-1166.2][0], [x['id'] for x in t if float(x['amount'])==-1000][0])")
VST0=$(vorsteuer)
assert_eq "fixture: Vorsteuer of the bill" "$VST0" "190.00"

note "=== refused ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TSK/book-expense?companyId=$C" '{"expenseId":"'$ER'"}'
assert_eq "less than the bill without skonto" "$STATUS" "400"
assert_eq "…the message names the Skonto" "$(says "Skonto")" "yes"
AS POST "/api/v1/bank-statements/$SID/transactions/$TLOW/book-expense?companyId=$C" '{"expenseId":"'$ER'","skonto":true}'
assert_eq "a difference over 10 % is no Skonto" "$STATUS" "400"

note "=== paid less 2 % Skonto ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TSK/book-expense?companyId=$C" '{"expenseId":"'$ER'","skonto":true}'
assert_eq "booked (was 400)" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
assert_eq "the bill is paid" "$(paid "$ER")" "$Y-06-08"
assert_eq "a Skonto credit note: net −20, VAT −3,80, settled" "$(skonti)" "[('ER-1-SKONTO', -20.0, -3.8, '$Y-06-08')]"
assert_eq "Vorsteuer 186,20 (§ 17 UStG)" "$(vorsteuer)" "186.20"
assert_eq "nothing owed" "$(owed)" "0"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR: cost 980" "$(py 'print(-d["totals"]["gewinn"])')" "980"
curl -sS -o /tmp/t452.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "DATEV: the Kreditor is settled" "$(datev_balance /tmp/t452.csv 70001)" "0.00"

note "=== the Storno of the payment ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch"}'
assert_eq "Storno" "$STATUS" "201"
assert_eq "the bill is open again" "$(paid "$ER")" "-"
assert_eq "…and the Skonto gone with it" "$(skonti)" "[]"
assert_eq "Vorsteuer back to 190" "$(vorsteuer)" "190.00"
assert_eq "the whole bill owed" "$(owed)" "1190"

summary
