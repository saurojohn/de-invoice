#!/bin/bash
# Tier 444 — a reversed bank booking no longer pays the expense
#
# Measured before: a bank debit booked against an expense (book-expense with
# expenseId) set the expense's paidAt. Reversing that voucher (Storno) took
# the booking back in the journal but not the payment:
#   - the expense stayed paid (paidAt), so the balance sheet owed the
#     supplier nothing, the SEPA run did not offer it, DATEV still booked the
#     payment row from paidAt (Tier 432) — and since Tier 443 the expense was
#     locked as "bereits bezahlt": no correction, no delete;
#   - the bank transaction kept voucherId → the original voucher, so it could
#     never be booked again ("bereits als Aufwand gebucht"), although the money
#     had left the account.
# A correction (/correct: Storno + new booking) is a different case: the
# payment happened, only its booking changes — the expense stays paid.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-233-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier444-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
expense() { # number
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1'","invoiceDate":"'$Y'-06-01","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
  json_field "$BODY" id
}
E1=$(expense ER-FALSCH)
E2=$(expense ER-RICHTIG)

# One debit of 119,00 on 2 June.
MT=/tmp/t444-$TAG.mt940
cat > "$MT" <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST444
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR1000,00
:61:2606020602D119,00NTRFNONREF//Lieferant Juni
Lieferant
:62F:C260602EUR881,00
-
EOF
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
TXN=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==-119][0])")
[[ -n "$TXN" ]] && pass "fixture: the debit is imported" || fail "import: $UP"

note "=== booked against the wrong expense ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TXN/book-expense?companyId=$C" '{"expenseId":"'$E1'"}'
assert_eq "booked" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
assert_eq "ER-FALSCH paid on the value date" "$(paid "$E1")" "$Y-06-02"
assert_eq "owed: only ER-RICHTIG" "$(owed)" "119"

note "=== the voucher is reversed ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsche Eingangsrechnung"}'
assert_eq "Storno" "$STATUS" "201"
assert_eq "ER-FALSCH is unpaid again (was paid)" "$(paid "$E1")" "-"
assert_eq "owed: both again (was 119)" "$(owed)" "238"
AS GET "/api/v1/ustva/expenses?companyId=$C"
assert_eq "ER-FALSCH can be corrected again (was locked: bereits bezahlt)" \
  "$(py 'print([bool(e.get("lockReason")) for e in d if e["invoiceNumber"]=="ER-FALSCH"][0])')" "False"
AS GET "/api/v1/payments/unpaid?companyId=$C"
assert_eq "both are offered for payment again" "$(py 'print(sorted(e["invoiceNumber"] for e in (d if isinstance(d,list) else d.get("items",[]))))')" "['ER-FALSCH', 'ER-RICHTIG']"

note "=== the debit is booked again, against the right expense ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TXN/book-expense?companyId=$C" '{"expenseId":"'$E2'"}'
assert_eq "the transaction can be booked again (was 400: bereits gebucht)" "$STATUS" "201"
V2=$(json_field "$BODY" voucherId)
assert_eq "ER-RICHTIG paid" "$(paid "$E2")" "$Y-06-02"
assert_eq "ER-FALSCH still open" "$(paid "$E1")" "-"
assert_eq "owed: ER-FALSCH only" "$(owed)" "119"
curl -sS -o /tmp/t444.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "DATEV: the Kreditor owes ER-FALSCH only" "$(datev_balance /tmp/t444.csv 70001)" "-119.00"
AS POST "/api/v1/bank-statements/$SID/transactions/$TXN/book-expense?companyId=$C" '{"expenseId":"'$E1'"}'
assert_eq "booked once: a second booking is refused" "$STATUS" "400"

note "=== a correction keeps the payment ==="
AS GET "/api/v1/accounting/vouchers/$V2?companyId=$C"
LINES=$(py 'import json;print(json.dumps([{"accountId":l["accountId"],"debit":float(l["debit"]),"credit":float(l["credit"]),"description":"korrigiert"} for l in d["lines"]]))')
AS POST "/api/v1/accounting/vouchers/$V2/correct?companyId=$C" '{"date":"'$Y'-06-03T00:00:00Z","reason":"Text","lines":'"$LINES"'}'
assert_eq "Korrektur" "$STATUS" "201"
assert_eq "ER-RICHTIG stays paid" "$(paid "$E2")" "$Y-06-02"
assert_eq "owed unchanged" "$(owed)" "119"

note "=== a payment made otherwise stays ==="
E3=$(expense ER-SEPA)
AS POST "/api/v1/payments/batches" '{"companyId":"'$C'","expenseIds":["'$E3'"],"executionDate":"'$Y'-06-05","debtorIban":"DE02120300000000202051","debtorName":"'$TAG' GmbH"}'
cat > "$MT" <<'EOF2'
:1:F01BANKBICAXXX0000000000
:20:ST444B
:25:DE89370400440532013000
:28C:1/1
:60F:C260605EUR881,00
:61:2606050605D119,00NTRFNONREF//SEPA Sammler
Lieferant
:62F:C260605EUR762,00
-
EOF2
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID3=$(json_field "$UP" id)
TXN3=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==-119][0])")
AS POST "/api/v1/bank-statements/$SID3/transactions/$TXN3/book-expense?companyId=$C" '{"expenseId":"'$E3'"}'
V3=$(json_field "$BODY" voucherId)
AS POST "/api/v1/accounting/vouchers/$V3/reversal?companyId=$C" '{"reason":"doppelt"}'
assert_eq "Storno of the bank booking: the SEPA batch still pays ER-SEPA" "$STATUS/$(paid "$E3")" "201/$Y-06-05"

summary
