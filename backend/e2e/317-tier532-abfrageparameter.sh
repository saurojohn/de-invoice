#!/bin/bash
# Tier 532 — a malformed query parameter is a 400; no NUL reaches the database
#
# All 251 GET routes were called with dates that are none (`abc`,
# `2026-02-30`, `2026-13-45`), page numbers below 1 or not numbers, a year of
# 99999 and a NUL character in a search. Measured: 500 on 17 routes — the
# Kassenbuch (entries, day, close, closes, month, export, Kassenabschluss
# PDF), the voucher list, the customer / invoice / product lists, the mail
# log, stock history, the sales / customer reports, the DATEV export and
# preview, the UStVA expenses — and on every route that searches text, and
# on every JSON body carrying "\u0000".
#
# Now: 400, naming the parameter. A valid request answers as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-317-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier532-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
code() { curl -s -o /tmp/t532.out -w '%{http_code}' -m 30 "$API$1" -H "x-user-id: $U" -H "x-company-id: $C"; }
bad() { assert_eq "$2: 400 (was 500)" "$(code "$1")" "400"; }
ok() { assert_eq "$2: 200" "$(code "$1")" "200"; }
Q="companyId=$C"

note "=== dates that are none ==="
bad "/api/v1/cashbook/entries?$Q&from=abc" "Kassenbuch entries, from=abc"
bad "/api/v1/cashbook/entries?$Q&from=2026-13-45" "…from=2026-13-45"
bad "/api/v1/cashbook/day?$Q&date=2026-02-30" "Kassenbuch day, 30 February"
bad "/api/v1/cashbook/close?$Q&date=abc" "Kassenbuch close, date=abc"
bad "/api/v1/cashbook/closes?$Q&to=abc" "Kassenbuch closes, to=abc"
bad "/api/v1/cashbook/export?$Q&from=abc&to=abc" "Kassenbuch export, from=abc"
bad "/api/v1/cashbook/kassenabschluss.pdf?$Q&date=abc" "Kassenabschluss PDF, date=abc"
bad "/api/v1/accounting/vouchers?$Q&startDate=abc" "voucher list, startDate=abc"
bad "/api/v1/reports/sales?$Q&startDate=abc" "sales report, startDate=abc"
bad "/api/v1/reports/customers?$Q&endDate=abc" "customer report, endDate=abc"
bad "/api/v1/reports/datev-export?$Q&startDate=abc" "DATEV export, startDate=abc"
bad "/api/v1/reports/datev-preview?$Q&endDate=abc" "DATEV preview, endDate=abc"
bad "/api/v1/mail/emails?$Q&dateFrom=abc" "mail log, dateFrom=abc"
assert_eq "…the answer names the parameter" "$(grep -c "dateFrom" /tmp/t532.out)" "1"

note "=== numbers that are none ==="
bad "/api/v1/cashbook/entries?$Q&page=-1" "Kassenbuch entries, page=-1"
bad "/api/v1/cashbook/month?$Q&year=99999&month=99" "Kassenbuch month, year 99999"
bad "/api/v1/cashbook/month?$Q&year=abc&month=1" "Kassenbuch month, year=abc"
bad "/api/v1/accounting/vouchers?$Q&skip=-1" "voucher list, skip=-1"
bad "/api/v1/customers?$Q&page=abc" "customer list, page=abc"
bad "/api/v1/invoices?$Q&pageSize=abc" "invoice list, pageSize=abc"
bad "/api/v1/products?$Q&page=abc" "product list, page=abc"
bad "/api/v1/mail/emails?$Q&page=abc" "mail log, page=abc"
bad "/api/v1/inventory/00000000-0000-0000-0000-000000000000/history?$Q&limit=abc" "stock history, limit=abc"
bad "/api/v1/ustva/expenses?$Q&year=99999&month=99" "UStVA expenses, year 99999"

note "=== a NUL character ==="
bad "/api/v1/customers?$Q&search=%00" "customer search with %00"
bad "/api/v1/invoices?$Q&search=a%00b" "invoice search with %00"
bad "/api/v1/audit-logs/export.csv?$Q&q=%00" "audit export with %00"
S=$(curl -s -o /tmp/t532.out -w '%{http_code}' -X POST "$API/api/v1/customers?$Q" -H "x-user-id: $U" -H "x-company-id: $C" \
  -H "Content-Type: application/json" -d '{"name":"a\u0000b","type":"business"}')
assert_eq "a customer named \"a\\u0000b\": 400 (was 500)" "$S" "400"
S=$(curl -s -o /tmp/t532.out -w '%{http_code}' -X POST "$API/api/v1/customers?$Q" -H "x-user-id: $U" -H "x-company-id: $C" \
  -H "Content-Type: application/json" -d '{"name":"ok","type":"business","address":{"street":"Weg 1\u0000","city":"X"}}')
assert_eq "…a NUL inside a nested field: 400" "$S" "400"

note "=== valid requests answer as before ==="
ok "/api/v1/cashbook/entries?$Q&from=2026-09-01&to=2026-09-30&page=1&pageSize=50" "Kassenbuch entries, a month"
ok "/api/v1/cashbook/entries?$Q&from=2026-09-01T00:00:00.000Z" "…with an ISO timestamp"
ok "/api/v1/cashbook/day?$Q&date=2026-09-15" "Kassenbuch day"
ok "/api/v1/cashbook/month?$Q&year=2026&month=9" "Kassenbuch month"
ok "/api/v1/accounting/vouchers?$Q&startDate=2026-01-01&endDate=2026-12-31&take=10&skip=0" "voucher list"
ok "/api/v1/customers?$Q&page=1&pageSize=20&search=M%C3%BCller" "customer list with an umlaut search"
ok "/api/v1/invoices?$Q&page=2&pageSize=10" "invoice list, page 2"
ok "/api/v1/reports/sales?$Q&startDate=2026-01-01&endDate=2026-12-31" "sales report"
ok "/api/v1/reports/sales?$Q" "sales report without dates (the current year)"
ok "/api/v1/ustva/expenses?$Q&year=2026&quarter=3" "UStVA expenses, Q3"
ok "/api/v1/mail/emails?$Q&page=1&pageSize=50&dateFrom=2026-01-01" "mail log"
rm -f /tmp/t532.out

summary
