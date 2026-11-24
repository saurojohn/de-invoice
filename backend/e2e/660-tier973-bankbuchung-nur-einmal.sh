#!/bin/bash
# Tier 973 — one bank entry, one booking
#
# A bank entry booked as a tax refund (book-tax) could still be matched to an
# invoice: measured, a credit of 119 € booked to the UStJA 2025 and then
# matched to an invoice of 119 € — two vouchers for one credit, the invoice
# paid by money that was the tax office's, the bank 119 € above the statement.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-660-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
D=$(TZ=Europe/Berlin date -v-5d +%y%m%d 2>/dev/null || TZ=Europe/Berlin date -d '5 days ago' +%y%m%d)
DI=$(TZ=Europe/Berlin date -v-20d +%F 2>/dev/null || TZ=Europe/Berlin date -d '20 days ago' +%F)
Y=$(TZ=Europe/Berlin date +%Y)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier973-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$DI\",\"deliveryDate\":\"$DI\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
{
  printf ':20:ST5\n:25:DE89370400440532013000\n:28C:1/1\n:60F:C%sEUR0,00\n' "$D"
  printf ':61:%sC119,00NTRFNONREF\n:86:166?00GUTSCHRIFT?20Erstattung USt?32Finanzamt Koeln\n' "$D"
  printf ':62F:C%sEUR119,00\n-\n' "$D"
} > "$W/st.mt940"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$W/st.mt940;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U")
SID=$(json_field "$UP" id)
T=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['transactions'][0]['id'])" 2>/dev/null)
AS POST "/api/v1/bank-statements/$SID/transactions/$T/book-tax?companyId=$C" "{\"kind\":\"ustja\",\"year\":$((Y-1))}"
assert_eq "the credit of 119 € booked as a VAT refund" "${STATUS:0:2}" "20"
AS POST "/api/v1/bank-statements/$SID/transactions/$T/match?companyId=$C" "{\"invoiceId\":\"$I\"}"
assert_eq "…the same entry matched to an invoice of 119 €: refused (was 201 — a second voucher)" "$STATUS" "400"
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "…the invoice stays open" "$(json_field "$BODY" status)" "sent"

summary
