#!/bin/bash
# Tier 454 — the EÜR counts what was paid, when it was paid (§ 11 EStG)
#
# Measured before: the Anlage EÜR took every sent invoice at its issue date and
# every expense at its invoice date — a Soll-EÜR. § 4 Abs. 3 EStG is a cash
# statement (Zufluss-/Abflussprinzip, § 11): an invoice of November 2025 paid
# in January 2026 is income of 2026, an unpaid invoice is no income yet, a
# bill of December 2025 paid in January 2026 is a 2026 expense.
#   - 2025 showed 1 000 revenue for an invoice not paid before 2026, and the
#     300 cost of a bill paid in 2026
#   - 2026 showed the unpaid invoice (200) and the unpaid bill (400), the half-
#     paid invoice in full (500), and the invoice paid in 2026 not at all
# An expense had no way to record a payment made outside the bank import, the
# SEPA run and the cash book (card, private account): `paidAt` was refused.
#
# Now: income is each payment's net share (payment × net / gross of its
# invoice); a credit note settling the invoice ('Gutschrift') and an
# overpayment beyond the invoice are no income of it; an invoice set "paid"
# without a recorded payment counts at its issue date (as before). Expenses
# count at `paidAt`, which can now be entered ("Bezahlt am").
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-243-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier454-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; S=$(json_field "$BODY" id)
sent() { # issueDate net [extra] → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",${3:+$3,}\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"; [[ "$STATUS" == 201 ]] || fail "payment $*: $STATUS $BODY"; }
bill() { # invoiceDate net [paidAt] → id
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-'$RANDOM'","description":"Ware","invoiceDate":"'$1'","netAmount":'$2',"vatRate":0.19,"vatAmount":'$(python3 -c "print(round($2*0.19,2))")',"grossAmount":'$(python3 -c "print(round($2*1.19,2))")',"category":"Material"'${3:+,\"paidAt\":\"$3\"}'}'
  echo "$STATUS $(json_field "$BODY" id)"
}
euer() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$1"; py 'e=d["totals"];print("%g/%g" % (e["einnahmenTotal"], e["ausgabenTotal"]))'; }

note "=== fixtures ==="
A=$(sent 2025-11-10 1000); pay "$A" 1190 2026-01-15           # 2025 invoice, paid 2026
B=$(sent 2026-03-01 500);  pay "$B" 297.50 2026-03-20         # half paid
C3=$(sent 2026-04-01 200)                                      # unpaid
O=$(sent 2026-05-01 100);  pay "$O" 150 2026-05-10            # overpaid by 31
SK=$(sent 2026-06-01 1000 '"skontoPercent":2,"skontoDays":14'); pay "$SK" 1166.20 2026-06-05   # less 2 % Skonto
D=$(sent 2026-07-01 300);  AS PUT "/api/v1/invoices/$D/status?companyId=$C" '{"status":"paid"}'  # paid, no payment recorded
read -r ST1 E1 < <(bill 2025-12-20 300 2026-01-10)
assert_eq "an expense with its payment date (was 400: paidAt refused)" "$ST1" "201"
read -r _ E2 < <(bill 2026-06-01 400)
AS GET "/api/v1/expenses/$E1?companyId=$C"
assert_eq "…stored" "$(py 'print((d.get("paidAt") or "-")[:10])')" "2026-01-10"

note "=== 2025: nothing was paid ==="
assert_eq "EÜR 2025: 0 income, 0 cost (was 1000/300)" "$(euer 2025)" "0/0"

note "=== 2026: what was paid ==="
# A 1000 + B 250 + O 100 (not the 31 over) + SK 980 (the Skonto credit note is
# no income) + D 300 (no payment recorded: issue date) ; E1 300, not E2
assert_eq "EÜR 2026: 2630 income, 300 cost (was 2080/400)" "$(euer 2026)" "2630/300"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "open documents are counted apart: 2 invoices (B, C), 1 expense (E2)" \
  "$(py 'o=d["counts"].get("unbezahlt") or {};print("%s/%s" % (o.get("invoices"), o.get("expenses")))')" "2/1"
assert_eq "the principle is named" "$(py 'print(d.get("prinzip"))')" "zufluss"

note "=== the rest of B paid in 2027 ==="
pay "$B" 297.50 2027-01-05
assert_eq "EÜR 2027: 250 (the second half)" "$(euer 2027)" "250/0"
assert_eq "EÜR 2026 unchanged" "$(euer 2026)" "2630/300"

note "=== the payment date of an expense can be corrected or taken out ==="
AS PUT "/api/v1/expenses/$E2?companyId=$C" '{"paidAt":"2026-12-30"}'
assert_eq "E2 paid 2026-12-30" "$STATUS" "200"
assert_eq "EÜR 2026: 700 cost" "$(euer 2026)" "2630/700"
AS PUT "/api/v1/expenses/$E2?companyId=$C" '{"paidAt":null}'
assert_eq "…and back to unpaid" "$STATUS" "200"
assert_eq "EÜR 2026: 300 cost" "$(euer 2026)" "2630/300"

note "=== a supplier credit note counts when its money comes back ==="
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-1","description":"Retoure","invoiceDate":"2026-02-01","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119,"category":"Material","creditNote":true}'
GS=$(json_field "$BODY" id)
assert_eq "EÜR 2026: not refunded yet, 300 cost" "$(euer 2026)" "2630/300"
AS PUT "/api/v1/expenses/$GS?companyId=$C" '{"paidAt":"2026-02-10"}'
assert_eq "EÜR 2026: refunded, 200 cost" "$(euer 2026)" "2630/200"

summary
