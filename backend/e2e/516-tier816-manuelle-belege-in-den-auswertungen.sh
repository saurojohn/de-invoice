#!/bin/bash
# Tier 816 — manual vouchers in the reports, as an accountant decides
#
# Measured (Tier 812): a manual voucher changed no report — the reports read
# the documents, not the journal. Decided on 07.11.2026 (the owner left it to
# the accountant's judgement), manual-journal.ts:
#   - GuV, BWA, Anlage G of a balance-sheet company, and through them KSt 1,
#     the GewSt, the Bilanz and the E-Bilanz, count a manual voucher's lines on
#     expense and revenue accounts (as the adviser's DATEV does), each in its
#     own period, a Storno in its own; income taxes booked by hand stay out of
#     the GuV (position 14 is computed);
#   - the EÜR counts a manual voucher only when it moved money (a line on cash
#     or bank);
#   - no UStVA adds a manual voucher's VAT (§ 15 UStG: the invoice) — GET
#     /ustva/manual-vat shows it beside the return.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-516-$(date +%s%N | cut -c1-13)"

reg() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier816-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
fixture_issuer "$C" DE811111116
[[ -n "${C:-}" ]] && pass "fixture: a fresh GmbH" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS GET "/api/v1/ustva/deadlines?companyId=$C"; Y=$(( $(P "d['today'][:4]") - 1 ))
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/accounting/accounts/seed?companyId=$C"
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"0970","name":"Sonstige Rückstellungen","type":"liability"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"2650","name":"Sonstige Zinsen und ähnliche Erträge","type":"revenue"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"4950","name":"Rechts- und Beratungskosten","type":"expense"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"4830","name":"Abschreibungen auf Sachanlagen","type":"expense"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"3400","name":"Wareneingang 19 %","type":"expense"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"0400","name":"Betriebsausstattung","type":"asset"}'
acct() { q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='$1'"; }
A0970=$(acct 0970); A2650=$(acct 2650); A4950=$(acct 4950); A4830=$(acct 4830); A3400=$(acct 3400); A0400=$(acct 0400); A1200=$(acct 1200); A1576=$(acct 1576)
[[ -n "$A0970$A2650$A4950$A4830$A3400$A0400" ]] && pass "fixture: the accounts" || fail "accounts"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$(json_field "$BODY" id)\",\"issueDate\":\"$Y-03-05\",\"items\":[{\"description\":\"Leder\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an invoice of 10 000 € net" "$STATUS" "200"

report() { # the numbers this spec reads
  AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
  local g; g=$(P "' '.join('%s=%.2f' % (l['position'], l['amount'] or 0) for s in ('revenue','cost','financial') for l in d[s]['lines'] if l['position'] in ('1','4','5a','7a','8','11','13')) + ' BE=%.2f' % d['totals']['betriebsergebnis']")
  AS GET "/api/v1/reports/bwa?companyId=$C&year=$Y&month=12"
  local b; b=$(P "' '.join('%s=%.2f' % (l['bucket'], l['ytd']) for l in d['lines'] if l['bucket'] in ('1000','2000','3100','3600','4100'))")
  echo "$g | $b"
}
BEFORE=$(report)
assert_eq "fixture: before any manual voucher" "$BEFORE" "1=10000.00 4=0.00 5a=0.00 7a=0.00 8=0.00 11=0.00 13=0.00 BE=10000.00 | 1000=10000.00 2000=0.00 3100=0.00 3600=0.00 4100=0.00"

VOUCHER() { AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"$1\",\"description\":\"$2 $TAG\",\"referenceType\":\"Manual\",\"lines\":$3}"; json_field "$BODY" id; }
VOUCHER "$Y-12-31" "Abschlusskosten" "[{\"accountId\":\"$A4950\",\"debit\":1500,\"credit\":0},{\"accountId\":\"$A0970\",\"debit\":0,\"credit\":1500}]" >/dev/null
VOUCHER "$Y-06-30" "Habenzinsen" "[{\"accountId\":\"$A1200\",\"debit\":20,\"credit\":0},{\"accountId\":\"$A2650\",\"debit\":0,\"credit\":20}]" >/dev/null
VOUCHER "$Y-04-10" "Wareneinkauf" "[{\"accountId\":\"$A3400\",\"debit\":300,\"credit\":0},{\"accountId\":\"$A1576\",\"debit\":57,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":357}]" >/dev/null
VOUCHER "$Y-12-31" "AfA Regal" "[{\"accountId\":\"$A4830\",\"debit\":100,\"credit\":0},{\"accountId\":\"$A0400\",\"debit\":0,\"credit\":100}]" >/dev/null
R=$(VOUCHER "$Y-05-05" "Versehen" "[{\"accountId\":\"$A4950\",\"debit\":999,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":999}]")
# reversed: its Storno is dated today — the next year; the year sees the voucher, the next one the Storno
AS POST "/api/v1/accounting/vouchers/$R/reversal?companyId=$C" '{}'
assert_eq "fixture: five manual vouchers, one reversed today" "$STATUS" "201"

AFTER=$(report)
assert_eq "GuV and BWA count them (was: unchanged): sales —, other costs 1 500 + 999, material 300, AfA 100, Habenzinsen 20" \
  "$AFTER" "1=10000.00 4=0.00 5a=300.00 7a=100.00 8=2499.00 11=20.00 13=0.00 BE=7101.00 | 1000=10000.00 2000=300.00 3100=100.00 3600=2499.00 4100=20.00"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"
assert_eq "KSt 1 from the GuV: 7 101 + 20 interest" "$(P "'%.2f' % d['jahresueberschuss']")" "7121.00"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=$Y"
assert_eq "the GewSt from Anlage G: the same profit" "$(P "'%.2f' % d['gewerbeertrag']")" "7121.00"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
NET=$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position'] == '2400'][0]"); BAL=$(P "d['balanceCheck']['balanced']")
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "the Bilanz carries the GuV's net income, balanced" "$NET/$BAL" "$(P "d['totals']['jahresueberschuss']")/True"
AS GET "/api/v1/accounting/ebilanz?companyId=$C&year=$Y"
assert_eq "the E-Bilanz: the GuV's costs" "$(P "' '.join('%s=%.2f' % (p['source'], float(p['value'])) for p in sorted(d['positions'], key=lambda p: p['source']) if p['source'] in ('guv.materialaufwand', 'guv.afa', 'guv.sonstigeAufwendungen'))")" \
  "guv.afa=100.00 guv.materialaufwand=300.00 guv.sonstigeAufwendungen=2499.00"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$((Y + 1))"
assert_eq "the next year: the Storno, dated today, takes the 999 back" "$(P "'%.2f' % [l['amount'] for l in d['cost']['lines'] if l['position'] == '8'][0]")" "-999.00"

note "=== the UStVA: shown, not counted ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=4"
assert_eq "April's return: the manual Vorsteuer is not in it" "$(P "'%.2f' % d['vorsteuerSum']")" "0.00"
AS GET "/api/v1/ustva/manual-vat?companyId=$C&year=$Y&month=4"
assert_eq "GET /ustva/manual-vat (was 404): it is shown beside the return" "$STATUS/$(P "'%.2f %.2f %s' % (d['vorsteuer'], d['umsatzsteuer'], [(v['accountNumber'], '%.2f' % v['amount']) for v in d['vouchers']])")" "200/57.00 0.00 [('1576', '57.00')]"

note "=== an EÜR: only what moved money ==="
read -r U2 C2 < <(reg "$TAG-e")
U=$U2; C=$C2
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
AS POST "/api/v1/accounting/accounts/seed?companyId=$C"
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"0970","name":"Sonstige Rückstellungen","type":"liability"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"4210","name":"Miete","type":"expense"}'
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"4950","name":"Rechts- und Beratungskosten","type":"expense"}'
A0970=$(acct 0970); A4210=$(acct 4210); A4950=$(acct 4950); A1200=$(acct 1200)
VOUCHER "$Y-02-01" "Miete" "[{\"accountId\":\"$A4210\",\"debit\":800,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":800}]" >/dev/null
VOUCHER "$Y-12-31" "Rückstellung" "[{\"accountId\":\"$A4950\",\"debit\":400,\"credit\":0},{\"accountId\":\"$A0970\",\"debit\":0,\"credit\":400}]" >/dev/null
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "the EÜR: the rent paid from the bank (Raumkosten), not the provision (no money moved)" \
  "$(P "('%.2f' % d['totals']['ausgabenTotal'], [(l['kennziffer'], '%.2f' % l['amount']) for l in d['ausgaben'] if l['amount']])")" "('800.00', [('5400', '800.00')])"

summary
