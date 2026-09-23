#!/bin/bash
# Tier 432 — an expense paid by SEPA is paid in DATEV too
#
# Measured before: an expense of 119 € paid through the SEPA credit-transfer
# run (paidAt set, the balance sheet's 4000 at 0) exported to DATEV as
# "Kreditor 70001 an 4900 119,00 H" and nothing else — no payment, so the
# supplier stayed owed 119 € in the Berater's books.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-221-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); FROM=$(date +%Y-%m-01)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier432-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"},\"bankInfo\":{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
S=$(json_field "$BODY" id)
expense() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$S\",\"invoiceNumber\":\"$1\",\"description\":\"$1\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"; json_field "$BODY" id; }
SEPA=$(expense ER-SEPA); BAR=$(expense ER-BAR)
AS POST "/api/v1/payments/batches" "{\"companyId\":\"$C\",\"expenseIds\":[\"$SEPA\"],\"executionDate\":\"$TODAY\",\"debtorIban\":\"DE02120300000000202051\",\"debtorName\":\"$TAG GmbH\"}"
assert_eq "SEPA run" "$STATUS" "201"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$TODAY\",\"type\":\"eroeffnung\",\"description\":\"Anfangsbestand\",\"amount\":500}"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$TODAY\",\"type\":\"ausgabe\",\"description\":\"Bar ER-BAR\",\"amount\":119,\"vatRate\":0.19,\"expenseId\":\"$BAR\"}"
assert_eq "cash payment of the other" "$STATUS" "201"

curl -sS -o /tmp/t432.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TODAY"
payments() { datev_rows /tmp/t432.csv | awk -F'\t' -v b="$1" '$1==b && ($3=="1200" || $3=="1000") {print $3":"$4":"$5":"$6}' | tr '\n' ' '; }
assert_eq "SEPA: Bank 1200 an Kreditor 70001, 119,00 H (was: no payment row)" "$(payments ER-SEPA)" "1200:70001:119.00:H "
assert_eq "cash: only the Kasse row, not a second payment from paidAt" "$(payments ER-BAR)" "1000:70001:119.00:H "
assert_eq "the Kreditor is settled in DATEV" "$(datev_balance /tmp/t432.csv 70001)" "0.00"

summary; exit $?
