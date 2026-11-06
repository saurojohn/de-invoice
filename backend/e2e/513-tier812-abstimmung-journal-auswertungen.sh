#!/bin/bash
# Tier 812 — the journal against the reports (Abstimmung)
#
# Measured: a manual voucher „Miete 1 000 € + Vorsteuer 190 € an Bank" left
# the EÜR, the UStVA, the GuV, the BWA and the Bilanz as they were — the
# reports read the documents, not the journal, and nothing said so. GET
# /accounting/abstimmung?year= lists the vouchers of a year that are in the
# journal and DATEV and in no report — manual vouchers and corrections with a
# line on an expense, revenue or VAT account, bank debits booked „Als
# Aufwand" before Tier 809 — with what they would add. A voucher with a Storno
# and the Storno are left out; a balance-sheet-only voucher (Privatentnahme)
# is no gap. The reports themselves are not changed (whether manual vouchers
# should count in them is the owner's decision).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-513-$(date +%s%N | cut -c1-13)"

# ── the rule ─────────────────────────────────────────────────────────────
RULE=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/accounting/journal-reconciliation')
const k = (type, category, ref) => String(f.kindOf({ type, category }, f.originOf(ref)))
console.log([
  f.originOf(null), f.originOf('Manual'), f.originOf('VoucherCorrection'), f.originOf('BankTransaction'), String(f.originOf('invoice')), String(f.originOf('Expense')),
  k('expense', 'operating', 'Manual'), k('revenue', 'sales', 'Manual'), k('asset', 'vat', 'Manual'), k('liability', 'vat', 'BankTransaction'), k('equity', 'private', 'Manual'),
].join(','))
" 2>&1 | tail -1)
assert_eq "what is a gap: hand-written vouchers and old bank expenses on expense / revenue / VAT accounts; not a bank tax payment on 1780, not a document's voucher" \
  "$RULE" "manual,manual,correction,bank-expense,null,null,aufwand,ertrag,steuer,null,null"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier812-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
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
A4900=$(acct 4900); A1576=$(acct 1576); A1200=$(acct 1200); A8200=$(acct 8200); A1776=$(acct 1776); A1800=$(acct 1800)
Y=2026
VOUCHER() { # date description lines → id
  AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"$1\",\"description\":\"$2\",\"referenceType\":\"Manual\",\"lines\":$3}"
  json_field "$BODY" id
}

AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=$Y"
assert_eq "GET /accounting/abstimmung (was 404): nothing booked, nothing missing" "$STATUS/$(P "(d['entries'], d['totals'])")" "200/([], {'aufwand': 0, 'ertrag': 0, 'steuer': 0})"

# ── the vouchers ─────────────────────────────────────────────────────────
VOUCHER "$Y-10-05" "Miete Oktober $TAG" "[{\"accountId\":\"$A4900\",\"debit\":1000,\"credit\":0},{\"accountId\":\"$A1576\",\"debit\":190,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":1190}]" >/dev/null
VOUCHER "$Y-10-06" "Barverkauf $TAG" "[{\"accountId\":\"$A1200\",\"debit\":119,\"credit\":0},{\"accountId\":\"$A8200\",\"debit\":0,\"credit\":100},{\"accountId\":\"$A1776\",\"debit\":0,\"credit\":19}]" >/dev/null
VOUCHER "$Y-10-07" "Privatentnahme $TAG" "[{\"accountId\":\"$A1800\",\"debit\":500,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":500}]" >/dev/null
R=$(VOUCHER "$Y-10-08" "Versehen $TAG" "[{\"accountId\":\"$A4900\",\"debit\":77,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":77}]")
AS POST "/api/v1/accounting/vouchers/$R/reversal?companyId=$C" '{}'
assert_eq "fixture: four manual vouchers, one reversed" "$STATUS" "201"
K=$(VOUCHER "$Y-10-09" "Porto $TAG" "[{\"accountId\":\"$A4900\",\"debit\":20,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":20}]")
AS POST "/api/v1/accounting/vouchers/$K/correct?companyId=$C" "{\"reason\":\"Betrag\",\"lines\":[{\"accountId\":\"$A4900\",\"debit\":25,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":25}]}"
assert_eq "fixture: a voucher corrected (Storno + correction)" "$STATUS" "201"
# a debit booked „Als Aufwand" before Tier 809: a voucher, no expense
q "with v as (insert into \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status)
     values (gen_random_uuid()::text, '$C', 'ALT-$TAG', '$Y-10-10', 'Stadtwerke alt', 'BankTransaction', 'posted') returning id)
   insert into \"VoucherLine\" (id, \"voucherId\", \"accountId\", debit, credit, \"sortOrder\")
   select gen_random_uuid()::text, v.id, x.a, x.d, x.c, x.o from v, (values ('$A4900', 50, 0, 0), ('$A1200', 0, 50, 1)) as x(a, d, c, o)" >/dev/null

AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=$Y"
assert_eq "listed by date: the rent, the cash sale, the old bank expense, the correction (dated today) — not the Privatentnahme, not the reversed pair, not the corrected original" \
  "$(P "[(e['date'], e['origin'], [(l['accountNumber'], l['kind'], l['debit'], l['credit']) for l in e['lines']]) for e in d['entries']]")" \
  "[('$Y-10-05', 'manual', [('4900', 'aufwand', 1000, 0), ('1576', 'steuer', 190, 0)]), ('$Y-10-06', 'manual', [('8200', 'ertrag', 0, 100), ('1776', 'steuer', 0, 19)]), ('$Y-10-10', 'bank-expense', [('4900', 'aufwand', 50, 0)]), ('$(q "select to_char(date,'YYYY-MM-DD') from \"Voucher\" where \"referenceType\"='VoucherCorrection' and \"companyId\"='$C'")', 'correction', [('4900', 'aufwand', 25, 0)])]"
assert_eq "…what they would add: 1 075 € costs, 100 € revenue, 171 € VAT (190 paid − 19 owed)" "$(P "d['totals']")" "{'aufwand': 1075, 'ertrag': 100, 'steuer': 171}"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "…and the reports really lack them: the EÜR is empty" "$(P "d['totals']['ausgabenTotal'], d['totals']['einnahmenTotal']")" "(0, 0)"
AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=$((Y - 1))"
assert_eq "another year: nothing" "$(P "len(d['entries'])")" "0"
AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=abc"
assert_eq "a year that is none: 400" "$STATUS" "400"

summary
