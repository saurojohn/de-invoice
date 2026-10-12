#!/bin/bash
# Tier 662 — the customer portal: what is open, per currency
#
# The portal's three tiles ("Offener Saldo", "Überfällig", "Bezahlt") added
# the TOTALS of the invoices that were not marked paid — an invoice of
# 2 380 € of which 2 000 € were paid stood there with 2 380 € open; a credit
# note counted as a negative invoice on top of the credit it had already
# booked on its invoice; and invoices in several currencies were added under
# the currency of the newest one. The list of payments on an invoice showed
# the payments on a USD invoice in euros: every Payment row carried the
# column's default, "EUR".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-393-$(date +%s%N | cut -c1-13)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
day() { python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$1)).isoformat())"; }
[[ "${EXCHANGE_RATES_MOCK:-}" == "1" ]] || { note "EXCHANGE_RATES_MOCK is not 1 — the fixed rates are needed"; summary; exit 0; }
TODAY=$(TZ=Europe/Berlin date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier662-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Importhaus Nord GmbH","type":"business","contact":{"email":"einkauf@importhaus.example"},"address":{"street":"Hafenweg 3","postalCode":"20457","city":"Hamburg","country":"DE"}}'; K=$(field "d['id']")
inv() { # currency price issue due
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$3'","dueDate":"'$4'","currency":"'$1'","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]}'
  local id; id=$(field "d['id']")
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}' >/dev/null
  echo "$id"
}
A=$(inv EUR 2000 "$(day 60)" "$(day 46)")   # 2 380 €, overdue; 2 000 € paid → 380 € open
B=$(inv EUR 1000 "$TODAY" 2099-12-31)        # 1 190 €; a credit note of 190 € → 1 000 € open
D=$(inv USD 10000 "$TODAY" 2099-12-31)       # 11 900 USD; 5 950 USD paid → 5 950 USD open
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":2000,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$B/credit-note?companyId=$C" '{"amount":190,"reason":"Nachlass"}'
AS POST "/api/v1/invoices/$D/payments?companyId=$C" '{"amount":5950,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer","eurAmount":5400}'
assert_eq "fixture: two EUR invoices (one part-paid, one credited in part) and a USD invoice, half paid" "$STATUS" "201"

note "=== 1. a payment is in the currency of its invoice ==="
assert_eq "the payment on the USD invoice (was EUR, the column's default)" "$(field "d['currency']")" "USD"
assert_eq "… and the credit booked on the EUR invoice" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select string_agg(distinct currency, ',') from \"Payment\" where \"invoiceId\" in ('$A','$B')")" "EUR"

note "=== 2. the portal's sums ==="
AS POST "/api/v1/customer-portal/admin/create-session" '{"customerId":"'$K'"}'; T=$(echo "$BODY" | grep -oE '[0-9a-f]{64}' | head -1)
[[ -n "$T" ]] && pass "a portal session for the customer" || { fail "no portal token: $BODY"; summary; exit 1; }
BODY=$(curl -sS "$API/api/v1/customer-portal/invoices?token=$T")
assert_eq "per currency, EUR first" "$(field "[c['currency'] for c in d['summary']['byCurrency']]")" "['EUR', 'USD']"
# was: totalOpen 15 280 "USD" — 2 380 + 1 190 − 190 + 11 900, under the newest invoice's currency
assert_eq "EUR: 380 + 1 000 open, 380 of it overdue, 2 000 paid" \
  "$(field "[(c['totalOpen'], c['totalOverdue'], c['totalPaid']) for c in d['summary']['byCurrency'] if c['currency'] == 'EUR'][0]")" "(1380, 380, 2000)"
assert_eq "USD: 5 950 open, none overdue, 5 950 paid" \
  "$(field "[(c['totalOpen'], c['totalOverdue'], c['totalPaid']) for c in d['summary']['byCurrency'] if c['currency'] == 'USD'][0]")" "(5950, 0, 5950)"
assert_eq "the old fields are the first currency's" "$(field "(d['summary']['currency'], d['summary']['totalOpen'])")" "('EUR', 1380)"
assert_eq "each invoice says what is open on it" \
  "$(field "sorted((i['currency'], i['total'], i['openAmount']) for i in d['invoices'] if i['type'] != 'CN')")" "[('EUR', '1190', '1000'), ('EUR', '2380', '380'), ('USD', '11900', '5950')]"

note "=== 3. the pages ==="
FE="$SCRIPT_DIR/../../frontend/src/app/portal"
grep -q 'summary.byCurrency' "$FE/page.tsx" && pass "the tiles show one line per currency" || fail "the portal page does not read byCurrency"
grep -q 'fmtEur(Number(p.amount), inv.currency)' "$FE/invoice/[id]/page.tsx" \
  && pass "a payment is shown in its invoice's currency (rows from before carry EUR)" || fail "the invoice page formats payments by their own column"

summary
