#!/bin/bash
# Tier 811 — POST /accounting/vouchers books manual vouchers only
#
# Measured before: the route took `referenceType` and `createdById` from the
# body. „Expense" with „[expense:<id>]" in the text marked an entered bill as
# paid by the bank — the expense list said „bezahlt", the expense was locked
# against changes, DATEV booked its payment, the SEPA run left it out — with
# no money moved; „BankReconciliation" kept the voucher out of DATEV and
# refused its Storno. (A `createdById` of another company's user was refused
# by the company guard already; the creator is now the signed-in user only.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-512-$(date +%s%N | cut -c1-13)"

reg() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier811-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
read -r U2 _ < <(reg "$TAG-b")
[[ -n "${C:-}" && -n "${U2:-}" ]] && pass "fixture: a fresh company, and a user of another" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS GET "/api/v1/accounting/accounts/seed?companyId=$C"
acct() { q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='$1'"; }
A4900=$(acct 4900); A1576=$(acct 1576); A1200=$(acct 1200)
[[ -n "$A4900" && -n "$A1576" && -n "$A1200" ]] && pass "fixture: the chart of accounts" || fail "fixture: the chart of accounts"

AS POST "/api/v1/expenses?companyId=$C" "{\"invoiceNumber\":\"$TAG-1\",\"description\":\"Miete\",\"invoiceDate\":\"2026-06-10\",\"netAmount\":500,\"vatRate\":0.19,\"vatAmount\":95,\"grossAmount\":595}"
E=$(json_field "$BODY" id)
assert_eq "fixture: an entered bill of 595 €, open" "$STATUS" "201"
LINES="[{\"accountId\":\"$A4900\",\"debit\":500,\"credit\":0},{\"accountId\":\"$A1576\",\"debit\":95,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":595}]"
N0=$(q "select count(*) from \"Voucher\" where \"companyId\"='$C'")

AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-10\",\"description\":\"Bank Miete [expense:$E]\",\"referenceType\":\"Expense\",\"lines\":$LINES}"
assert_eq "a voucher typed „Expense\" with the bill's tag: 400 (was 201)" "$STATUS/$(P "'nur manuelle Belege' in d['message']")" "400/True"
AS GET "/api/v1/expenses?companyId=$C&search=$TAG-1"
assert_eq "…the bill is still open and changeable (was: paid by the bank, locked)" \
  "$(P "[(x.get('paymentState'), x.get('lockReason')) for x in d['data']]")" "[('offen', None)]"
AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-10\",\"description\":\"x\",\"referenceType\":\"BankReconciliation\",\"lines\":$LINES}"
assert_eq "typed „BankReconciliation\" (kept out of DATEV, no Storno): 400" "$STATUS" "400"
assert_eq "…nothing booked" "$(q "select count(*) from \"Voucher\" where \"companyId\"='$C'")" "$N0"

AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-10\",\"description\":\"Umbuchung $TAG\",\"createdById\":\"$U2\",\"lines\":$LINES}"
assert_eq "a createdById of another company's user: refused (as before, by the company guard)" "$STATUS" "403"
AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-10\",\"description\":\"Umbuchung $TAG\",\"lines\":$LINES}"
V=$(json_field "$BODY" id)
assert_eq "a manual voucher without a type: booked as „Manual\" (was: no type)" "$STATUS/$(q "select \"referenceType\" from \"Voucher\" where id='$V'")" "201/Manual"
assert_eq "…booked by the signed-in user" "$(q "select \"createdById\" from \"Voucher\" where id='$V'")" "$U"
AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"2026-06-10\",\"description\":\"Umbuchung 2 $TAG\",\"referenceType\":\"Manual\",\"lines\":$LINES}"
assert_eq "typed „Manual\", as the page sends it: booked" "$STATUS" "201"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{}'
assert_eq "…and reversed like any manual voucher" "$STATUS" "201"

summary
