#!/bin/bash
# Tier 648 — the CSV files a person opens have a comma in their numbers
#
# Decided by the owner on 10.10.2026. Before, it depended on the export: the
# invoice list and the hours report wrote "1234.56" (which a German Excel
# reads as text, or as a date), the cash book "1.234,56" with a thousands
# separator and its daily-close column "154.7 EUR", the OSS report and
# everything for DATEV "1234,56".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-383-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
csv() { curl -sS -o "$2" -w '%{http_code}' "$API$1" -H "x-user-id: $U" -H "x-company-id: $C"; }
TODAY=$(TZ=Europe/Berlin date +%F)
CASHDAY=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=2)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier648-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Müller; Söhne GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1234.56,"vatRate":0.19}]}'; I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":469.13,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
assert_eq "fixture: an invoice over 1 469,13 €, 469,13 € paid, for a customer with a semicolon in its name" "$STATUS" "201"

note "=== 1. the invoice list ==="
CODE=$(csv "/api/v1/invoices/export/csv?companyId=$C&dateFrom=$TODAY&dateTo=$TODAY" "$TMP/inv.csv")
assert_eq "net, VAT, total, paid and open with a comma (was: 1234.56;234.57;1469.13 … 469.13;1000.00)" \
  "$CODE $(sed -n 2p "$TMP/inv.csv" | cut -d';' -f1-3 | sed 's/^INV-[0-9-]*/INV/') $(sed -n 2p "$TMP/inv.csv" | grep -o '1234,56;234,57;1469,13;EUR;;1;469,13;1000,00')" \
  "200 INV;INV;sent 1234,56;234,57;1469,13;EUR;;1;469,13;1000,00"
assert_eq "the name with a semicolon is one quoted cell; a number is not quoted for its comma" \
  "$(grep -c '"Müller; Söhne GmbH"' "$TMP/inv.csv")/$(grep -c '"1234,56"' "$TMP/inv.csv")/$(sed -n 2p "$TMP/inv.csv" | python3 -c "
import csv,sys
print(len(next(csv.reader(sys.stdin, delimiter=';'))))")" "1/0/18"

note "=== 2. the cash book ==="
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$CASHDAY'","type":"einnahme","description":"Barverkauf","amount":1234.5}'
AS POST "/api/v1/cashbook/close-day?companyId=$C" '{"date":"'$CASHDAY'","physicalCount":1234.5}'
CODE=$(csv "/api/v1/cashbook/export?companyId=$C&from=$CASHDAY&to=$CASHDAY" "$TMP/kasse.csv")
assert_eq "the amount without a thousands separator, the daily close with two decimals (was: \"1.234,50\" and '1234.5 EUR (Differenz: 0 EUR)')" \
  "$CODE $(sed -n 2p "$TMP/kasse.csv" | tr -d '\r' | cut -d';' -f6,9)" "200 1234,50;1234,50 EUR (Differenz: 0,00 EUR)"

note "=== 3. the hours report ==="
AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'$TODAY'","minutes":90,"description":"Beratung","customerId":"'$K'","hourlyRate":80.5}'
CODE=$(csv "/api/v1/time-entries/report.csv?companyId=$C&groupBy=customer&from=$TODAY&to=$TODAY" "$TMP/zeit.csv")
assert_eq "hours and amounts with a comma (was: 1.50 … 120.75)" "$CODE $(sed -n 2p "$TMP/zeit.csv")" '200 "Müller; Söhne GmbH";1;1,50;1,50;0,00;1,50;0,00;120,75'

note "=== 4. none of the three has a number with a point ==="
assert_eq "no cell of the three files is digits, a point and digits" \
  "$(cat "$TMP/inv.csv" "$TMP/kasse.csv" "$TMP/zeit.csv" | tr -d '\r' | tr ';' '\n' | grep -cE '^-?[0-9]+\.[0-9]+$')" "0"
summary
