#!/bin/bash
# Tier 800 — the dashboard's open payables are the unpaid bills of every year
#
# They were the unpaid bills of this year only: on a clock at 31.12.2026 the
# dashboard showed 238 € open at 23:37 and 0 € at 00:06, the bill unpaid all
# the same; a bill of an earlier year was never in the sum. The open
# receivables beside them have always counted every year.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-501-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier799-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
bill() { # date net number
  local body="{\"invoiceDate\":\"$1\",\"invoiceNumber\":\"$3\",\"description\":\"$TAG Material\",\"netAmount\":$2,\"vatRate\":0.19,\"vatAmount\":$(python3 -c "print(round($2*0.19,2))"),\"grossAmount\":$(python3 -c "print(round($2*1.19,2))"),\"category\":\"Material\"}"
  AS POST "/api/v1/ustva/expenses?companyId=$C" "$body"
  json_field "$BODY" id
}
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1)); PP=$((Y - 2))
LAST=$(bill "$P-12-31" 200 "L-$TAG-1")
OLDER=$(bill "$PP-06-30" 100 "L-$TAG-2")
NOW=$(bill "$Y-01-02" 50 "L-$TAG-3")
[[ -n "$LAST" && -n "$OLDER" && -n "$NOW" ]] && pass "fixture: three unpaid bills, of $PP, $P and $Y" || fail "fixture: bills ($STATUS $BODY)"
# an asset's AfA is no bill
AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG Presse\",\"anschaffungsDatum\":\"$P-01-01\",\"anschaffungsKosten\":1200,\"nutzungsdauerMonate\":12}"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$P" '{}'

open_payables() { AS GET "/api/v1/reports/dashboard?companyId=$C"; json_field "$BODY" openPayables; }
assert_eq "open payables: 238 + 119 + 59,50 — every year's unpaid bills (was 59,5, this year's only)" "$(open_payables)" "416.5"
q "update \"Expense\" set status='paid', \"paidAt\"='$Y-01-03' where id='$LAST'" >/dev/null
assert_eq "…a bill paid drops out" "$(open_payables)" "178.5"
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "…the receivables beside them: no invoices, 0" "$(json_field "$BODY" openReceivables)" "0"

summary
