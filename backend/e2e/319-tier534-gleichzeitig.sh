#!/bin/bash
# Tier 534 — the same request, several times at once
#
# The services read, decide and write in separate statements. Measured with
# one request sent in parallel (a double click, a retry, two users):
#   - an invoice issued 6× at once took its stock 5× over (10 → −5);
#   - 6 credit notes for one invoice: one created, five answered 500 (the
#     voucher number collided);
#   - one bank credit of 119 € matched to two invoices in parallel paid both;
#   - 6 Ratenpläne for one invoice (since Tier 522 nothing but the check
#     prevented them); credit of 81 € applied 6×;
#   - 4 opening balances in the Kassenbuch, 4 payments of 80 € out of 100 €.
# Now one request at a time per invoice / bank entry / customer / Kassenbuch
# (common/key-lock.ts): one succeeds, the others get the 400 they would get
# when sent after it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-319-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier534-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
H=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" "${H[@]}" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
D=$(mktemp -d)
# par n method path body → "ok/refused/errors" (2xx / 4xx / 5xx-or-none)
par() {
  local n=$1 m=$2 u=$3 b=$4 i; rm -f "$D"/c.*
  for i in $(seq 1 "$n"); do curl -s -o /dev/null -m 60 -w '%{http_code}' -X "$m" "$API$u" "${H[@]}" -d "$b" > "$D/c.$i" & done
  wait
  local ok=0 refused=0 err=0 c
  for i in $(seq 1 "$n"); do c=$(cat "$D/c.$i"); case "$c" in 2*) ok=$((ok+1));; 4*) refused=$((refused+1));; *) err=$((err+1));; esac; done
  echo "$ok/$refused/$err"
}
TODAY=$(date +%Y-%m-%d)
DUE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { # items-json [issue?] → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":$1}"; I=$(json_field "$BODY" id)
  [[ "${2:-issue}" == issue ]] && AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  return 0
}
ITEM='[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'

note "=== an invoice issued 6× at once ==="
AS POST "/api/v1/products?companyId=$C" "{\"name\":\"$TAG Gürtel\",\"basePrice\":50,\"vatRate\":0.19,\"trackInventory\":true,\"stockQuantity\":10}"
PR=$(json_field "$BODY" id)
inv "[{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":3,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}]" draft
R=$(par 6 PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}')
assert_eq "no server error" "${R##*/}" "0"
assert_eq "the stock is taken once: 7 (was −5)" "$(q "select \"stockQuantity\"::int from \"Product\" where id='$PR'")" "7"
assert_eq "…one sale in the history" "$(q "select count(*) from \"ProductStockHistory\" where reference='$I'")" "1"

note "=== two invoices selling the same product at once ==="
inv "[{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}]" draft; A=$I
inv "[{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}]" draft; B=$I
curl -s -o /dev/null -X PUT "$API/api/v1/invoices/$A/status?companyId=$C" "${H[@]}" -d '{"status":"sent"}' &
curl -s -o /dev/null -X PUT "$API/api/v1/invoices/$B/status?companyId=$C" "${H[@]}" -d '{"status":"sent"}' &
wait
assert_eq "both sales count: 7 − 2 − 1 = 4" "$(q "select \"stockQuantity\"::int from \"Product\" where id='$PR'")" "4"

note "=== 6 credit notes for one invoice ==="
inv "$ITEM"
R=$(par 6 POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"reason":"Storno"}')
assert_eq "one created, five refused, none failed (were 1 / 0 / 5)" "$R" "1/5/0"
assert_eq "…one credit note over 119 €" "$(q "select count(*)||'/'||abs(sum(total))::numeric(12,2) from \"Invoice\" where \"referenceInvoiceId\"='$I' and type='CN'")" "1/119.00"

note "=== one bank credit, two invoices ==="
inv "$ITEM"; A=$I; inv "$ITEM"; B=$I
MT="$D/s.mt940"
printf ':1:F01BANKBICAXXX0000000000\n:20:ST534\n:25:DE89370400440532013000\n:28C:1/1\n:60F:C260901EUR0,00\n:61:2609100910C119,00NTRFNONREF//A\nKunde\n:86:166?00GUTSCHRIFT?20Zahlung\n:62F:C260910EUR119,00\n-\n' > "$MT"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id); TX=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['transactions'][0]['id'])")
curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/bank-statements/$SID/transactions/$TX/match?companyId=$C" "${H[@]}" -d "{\"invoiceId\":\"$A\"}" > "$D/m.1" &
curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/bank-statements/$SID/transactions/$TX/match?companyId=$C" "${H[@]}" -d "{\"invoiceId\":\"$B\"}" > "$D/m.2" &
wait
assert_eq "one match booked, one refused (were 201 and 500)" "$(cat "$D/m.1" "$D/m.2" | fold -w3 | sort | tr '\n' ' ')" "201 400 "
assert_eq "…119 € received in all (were 238)" "$(q "select sum(amount)::numeric(12,2) from \"Payment\" where \"invoiceId\" in ('$A','$B')")" "119.00"

note "=== 6 Ratenpläne, credit applied 6× ==="
inv '[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]'
R=$(par 6 POST "/api/v1/installment-plans?companyId=$C" "{\"invoiceId\":\"$I\",\"installmentCount\":3,\"totalAmount\":1190,\"firstDueDate\":\"$DUE\",\"intervalDays\":30}")
assert_eq "one plan, five refused" "$R/$(q "select count(*) from \"InstallmentPlan\" where \"invoiceId\"='$I' and status='active'")" "1/5/0/1"
inv "$ITEM"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":200,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
inv "$ITEM"
R=$(par 6 POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$I\",\"amount\":81}")
assert_eq "the 81 € of credit are applied once" "$R/$(q "select coalesce(sum(amount),0)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$I'")" "1/5/0/81.00"

note "=== the Kassenbuch ==="
R=$(par 4 POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2026-09-10","type":"eroeffnung","description":"Anfang","amount":100}')
assert_eq "one opening balance (were 4)" "$R/$(q "select count(*) from \"CashBookEntry\" where \"companyId\"='$C' and type='eroeffnung'")" "1/3/0/1"
R=$(par 4 POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2026-09-11","type":"ausgabe","description":"Porto","amount":80}')
assert_eq "80 € out of 100 €: once (were 4 times, the till at −220 €)" "$R/$(q "select count(*) from \"CashBookEntry\" where \"companyId\"='$C' and type='ausgabe'")" "1/3/0/1"
rm -rf "$D"

summary
