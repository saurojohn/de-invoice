#!/bin/bash
# Tier 460 — deleting a payment takes back what the payment caused
#
# A payment can do more than reduce the open balance: beyond the total it
# becomes the customer's credit (Tier 58), inside the Skonto period it books
# the Skonto credit note (Tier 422), and a credit applied to an invoice is a
# payment too (Tier 431). DELETE /invoices/:id/payments/:paymentId removed only
# the payment. Measured before:
#   - 1 300 € paid on 1 190 €, deleted: the customer kept a 110 € credit for
#     money that never arrived (and could have it paid out)
#   - 1 166,20 € paid within 2 % Skonto, deleted: the Skonto credit note
#     stayed — 1 166,20 € open instead of 1 190 €, the UStVA 3,80 € short
#   - a credit applied to an invoice, the payment deleted: the credit was gone
# Now the delete takes each back — and refuses when the overpayment's credit
# has been used meanwhile.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-249-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier460-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
sent() { # [extra] → id   (1 000 € + 19 %)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",${1:+$1,}\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"; json_field "$BODY" id; }
del() { AS DELETE "/api/v1/invoices/$1/payments/$2?companyId=$C"; }
credit() { AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"; json_field "$BODY" balance; }
open_() { AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$1&level=first"; json_field "$BODY" openBalance; }
status() { AS GET "/api/v1/invoices/$1?companyId=$C"; json_field "$BODY" status; }

note "=== an overpayment deleted ==="
A=$(sent); PA=$(pay "$A" 1300)
assert_eq "fixture: 110 € credit" "$(credit)" "110"
del "$A" "$PA"
assert_eq "deleted" "$STATUS" "200"
assert_eq "the credit is gone with it (was 110)" "$(credit)" "0"
assert_eq "…the invoice open again" "$(status "$A")" "sent"

note "=== an overpayment whose credit was used ==="
PA=$(pay "$A" 1300)
B=$(sent)
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" '{"invoiceId":"'$B'","amount":110}'
assert_eq "fixture: the 110 € applied to another invoice" "$STATUS" "201"
del "$A" "$PA"
assert_eq "refused — the credit is spent" "$STATUS" "400"
assert_eq "…the message says so" "$(echo "$BODY" | grep -qi guthaben && echo yes || echo "no: $BODY")" "yes"
assert_eq "…the payment is still there" "$(status "$A")" "paid"

note "=== the applied credit's payment deleted ==="
AS GET "/api/v1/invoices/$B/payments?companyId=$C"
PB=$(py 'print([p["id"] for p in (d if isinstance(d,list) else d.get("data",[])) if p["paymentMethod"]=="Guthaben"][0])')
del "$B" "$PB"
assert_eq "deleted" "$STATUS" "200"
assert_eq "the customer has the 110 € credit back (was gone)" "$(credit)" "110"

note "=== a Skonto payment deleted ==="
S=$(sent '"skontoPercent":2,"skontoDays":14')
PS=$(pay "$S" 1166.20)
assert_eq "fixture: paid with Skonto" "$(status "$S")" "paid"
del "$S" "$PS"
assert_eq "deleted" "$STATUS" "200"
assert_eq "the whole 1 190 € open again (was 1 166,20)" "$(open_ "$S")" "1190"
assert_eq "…the Skonto credit note cancelled" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(status, ',') from \"Invoice\" where \"referenceInvoiceId\"='$S' and type='CN'")" "cancelled"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "…and the UStVA back to the full tax" \
  "$(py 'print([r["vat"] for r in d["salesByRate"] if abs(r["rate"]-0.19)<1e-6][0])')" "570"
PS=$(pay "$S" 1166.20)
assert_eq "paid again with Skonto: settled again" "$(status "$S")" "paid"

summary
