#!/bin/bash
# Tier 422 — a payment that takes the Skonto settles the invoice
#
# Measured before: a 1 190 € invoice with 2 % Skonto (14 days), paid
# 1 166,20 € on the issue day, stayed "sent" with 23,80 € open — the dunning
# run chased the discount the customer was entitled to (plus interest and
# fees) — and the UStVA kept 1 000 / 190 € although the price had been
# reduced (§ 17 UStG: 980 / 186,20). The bank-import path booked the Skonto as
# a gross 8730 line without correcting the VAT.
# Section 5 guards a mistake of Tier 421: credit notes are already among an
# invoice's payments (a synthetic 'Gutschrift' payment), and subtracting them
# again made the dunning ask 810 € on a 1 190 € invoice with a 190 € credit note.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-211-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m)
LATER=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=20)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier422-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
sent() { # body-fragment → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",$1}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"; }
status() { AS GET "/api/v1/invoices/$1?companyId=$C"; json_field "$BODY" status; }
open_() { AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$1&level=first"; json_field "$BODY" openBalance; }
cn() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select coalesce(string_agg(round(subtotal,2)||'/'||round(\"totalVat\",2), ';' order by \"totalVat\"), '-') from \"Invoice\" where \"referenceInvoiceId\"='$1' and type='CN'"; }
SK='"skontoPercent":2,"skontoDays":14'
L19='{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}'

note "=== 1. paid within the window, less the Skonto ==="
A=$(sent "$SK,\"items\":[$L19]")
pay "$A" 1166.20 "$TODAY"
assert_eq "payment accepted" "$STATUS" "201"
assert_eq "response carries the Skonto" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('skonto',{}).get('amount'))" "$BODY")" "23.8"
assert_eq "invoice paid (was 'sent')" "$(status "$A")" "paid"
assert_eq "nothing left to dun (was 23.80)" "$(open_ "$A")" "0"
assert_eq "Skonto credit note: net −20, USt −3.80" "$(cn "$A")" "-20.00/-3.80"

note "=== 2. a mixed-rate invoice: the Skonto is split over its rates ==="
B=$(sent "$SK,\"items\":[{\"description\":\"a\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19},{\"description\":\"b\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.07}]")
pay "$B" 221.48 "$TODAY"
assert_eq "226 − 2 % = 221.48 settles it" "$(status "$B")" "paid"
assert_eq "two credit-note lines: 7 % and 19 %" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(round(i.\"vatRate\"*100)::text, ',' order by i.\"vatRate\") from \"InvoiceItem\" i join \"Invoice\" c on c.id=i.\"invoiceId\" where c.\"referenceInvoiceId\"='$B'")" "7,19"

note "=== 3. no Skonto outside the window, or for a different amount ==="
L=$(sent "$SK,\"items\":[$L19]")
pay "$L" 1166.20 "$LATER"
assert_eq "paid after the window: stays open" "$(status "$L")" "sent"
assert_eq "…with 23.80 open, no credit note" "$(open_ "$L")/$(cn "$L")" "23.8/-"
W=$(sent "$SK,\"items\":[$L19]")
pay "$W" 1100 "$TODAY"
assert_eq "a partial payment that is not the Skonto: no credit note" "$(cn "$W")" "-"

note "=== 4. the UStVA sees the reduced price ==="
# A 980/186.20 + B (100−2)/(19−0.38) at 19 % … and L, W still at full price
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
R19=$(python3 -c "import sys,json;r=[x for x in json.loads(sys.argv[1])['salesByRate'] if abs(x['rate']-0.19)<1e-6][0];print('%s/%s'%(r['net'],r['vat']))" "$BODY")
assert_eq "19 %: 980 + 98 + 1000 + 1000 = 3078 / 584.82" "$R19" "3078/584.82"

note "=== 5. a credit note is counted once ==="
D=$(sent "\"items\":[$L19]")
AS POST "/api/v1/invoices/$D/credit-note?companyId=$C" '{"amount":190}'
assert_eq "1190 − credit note 190: 1000 open to dun (Tier 421 said 810)" "$(open_ "$D")" "1000"
pay "$D" 1000 "$TODAY"
assert_eq "…and paying the 1000 settles it" "$(status "$D")" "paid"
AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"
assert_eq "no overpayment anywhere — not from the Skonto credit notes either" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('balance'))" "$BODY")" "0"

summary; exit $?
