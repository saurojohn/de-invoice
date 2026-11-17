#!/bin/bash
# Tier 854 — the Mahnkosten a customer pays are income, not the customer's credit.
#
# Measured before (17.11.2026): a 2. Mahnung of 5 € and 15,43 € of interest,
# paid with the invoice (1 210,43 €). The 20,43 € became an overpayment — the
# customer's credit, which the next invoice would use up — and income nowhere:
# not in the GuV, the EÜR or DATEV, where the Debitor kept −20,43 €. Since
# Tier 852 a credit is (rightly) no income either. Mahngebühr and Verzugszinsen
# are damages, without VAT (UStAE 1.3 Abs. 6), and income: other income and
# interest income. What is paid beyond the invoice settles them first, costs
# before interest (§ 367 BGB); only the rest is the customer's credit.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$(TZ=Europe/Berlin date +%-m)
ISS=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=75)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=45)).isoformat())")
TAG="e2e-547-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier854-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"rechtsform":"GmbH","defaultVatMode":"standard","besteuerungsart":"soll","email":"info@t547.example.test","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
CU="{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
AS POST "/api/v1/customers?$q" "$CU"; K=$(json_field "$BODY" id)
invoice() { # → I N
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  AS POST "/api/v1/invoices?$q" "$b"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
}
mahnung() { local b="{\"companyId\":\"$C\",\"invoiceId\":\"$1\",\"level\":\"second\"}"; AS POST "/api/v1/reminders/send" "$b"; }
pay() { local b="{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"; AS POST "/api/v1/invoices/$1/payments?$q" "$b"; P=$(json_field "$BODY" id); }
dunning() { PSQL "select coalesce(sum(mahngebuehr), 0)::numeric(10,2)||' '||coalesce(sum(verzugszins), 0)::numeric(10,2) from \"DunningIncome\" where \"invoiceId\"='$1'"; }
credit() { PSQL "select coalesce(sum(amount), 0)::numeric(10,2) from \"CustomerCreditTransaction\" where \"companyId\"='$C' and type = 'overpayment'"; }

note "=== 1. a Mahnung paid in full with its costs ==="
invoice; A=$I; AN=$N
mahnung "$A"; assert_status 201 "fixture: a 2. Mahnung"
read -r FEE INT TOTAL < <(PSQL "select mahngebuehr::numeric(10,2)||' '||verzugszins::numeric(10,2)||' '||\"totalDue\"::numeric(10,2) from \"Mahnung\" where \"invoiceId\"='$A'" | tr ' ' ' ')
[[ "$FEE" == "5.00" ]] && pass "fixture: Mahngebühr 5 €, Verzugszinsen $INT €, due $TOTAL €" || fail "fixture: the Mahnung's fee is $FEE"
pay "$A" "$TOTAL"; A1=$P
assert_status 201 "the customer pays $TOTAL €"
assert_eq "…the Mahngebühr and the interest are income (was: none)" "$(dunning "$A")" "$FEE $INT"
assert_eq "…and no credit for the customer (was: $(python3 -c "print('%.2f' % ($FEE + $INT))") €)" "$(credit)" "0.00"
AS GET "/api/v1/accounting/guv?$q&year=$Y"
assert_eq "GuV: the fee as other income, the interest as interest income" \
  "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join('%s=%s' % (l['position'], l['amount']) for s in ('revenue','financial') for l in d[s]['lines'] if l['position'] in ('4','11')))")" \
  "4=$(python3 -c "print(float('$FEE'))" | sed 's/\.0$//') 11=$INT"
AS GET "/api/v1/ustva/compute?$q&year=$Y&month=$M"
assert_eq "UStVA: no tax on them (damages, not a supply)" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('umsatzsteuer'))")" "0"
DATEV=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?$q&startDate=$TODAY&endDate=$TODAY" | iconv -f latin1 -t utf-8)
assert_eq "DATEV: Debitor an 2700 (Mahngebühr) and an 2650 (Verzugszinsen), without a tax key" \
  "$(echo "$DATEV" | awk -F';' '$14 ~ /Mahngebühr|Verzugszinsen/ { print $1 "/" $8 "/" $9 }' | tr '\n' ' ')" \
  "$(echo "$FEE" | tr . ,)/2700/ $(echo "$INT" | tr . ,)/2650/ "
DEB=$(echo "$DATEV" | awk -F';' -v inv="\"$AN\"" 'NR > 2 && ($11 == inv || $12 == inv) { a = $1; gsub(/\./, "", a); sub(/,/, ".", a); if ($7 ~ /^1[0-9]{4}$/) s += ($2 == "\"S\"" ? a : -a); if ($8 ~ /^1[0-9]{4}$/) s -= ($2 == "\"S\"" ? a : -a) } END { printf "%.2f", s }')
CN_INV=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?$q&startDate=$ISS&endDate=$ISS" | iconv -f latin1 -t utf-8 | awk -F';' -v inv="\"$AN\"" '$11 == inv { a = $1; gsub(/\./, "", a); sub(/,/, ".", a); printf "%.2f", a }')
assert_eq "…the Debitor is settled: invoice $CN_INV − payment + Mahnkosten = 0" "$(python3 -c "print('%.2f' % (float('$CN_INV') + float('$DEB')))")" "0.00"

AS GET "/api/v1/customers/$K/statement?$q&from=$Y-01-01&to=$Y-12-31"
assert_eq "the customer's statement: a line „Mahnkosten“, and the balance 0 (was: −$(python3 -c "print('%.2f' % ($FEE + $INT))"), a credit the customer does not have)" \
  "$(echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
f=[l for l in d['lines'] if l['type'] == 'fees']
t=d['totals']
inv=t.get('invoicesAmount', t.get('invoices', 0)); cr=t.get('creditsAmount', 0); pay=t.get('paymentsAmount', 0)
print(len(f), '%.2f' % f[0]['amount'] if f else '-', '%.2f' % d.get('closingBalance', t.get('closingBalance', 0)))")" \
  "1 $(python3 -c "print('%.2f' % ($FEE + $INT))") 0.00"

note "--- the payment deleted: its Mahnkosten go with it ---"
AS DELETE "/api/v1/invoices/$A/payments/$A1?$q"
assert_status 200 "the payment removed"
assert_eq "…no income from it left" "$(dunning "$A")" "0.00 0.00"

note "=== 2. more than the Mahnung asks for ==="
pay "$A" "$(python3 -c "print('%.2f' % (float('$TOTAL') + 10))")"
assert_eq "the Mahnkosten are income" "$(dunning "$A")" "$FEE $INT"
assert_eq "…and only the 10 € beyond them the customer's credit" "$(credit)" "10.00"

note "=== 3. the invoice first, the costs later ==="
invoice; B=$I
mahnung "$B"
read -r FEE2 INT2 < <(PSQL "select mahngebuehr::numeric(10,2)||' '||verzugszins::numeric(10,2) from \"Mahnung\" where \"invoiceId\"='$B'")
pay "$B" 1190
assert_eq "the invoice's amount alone: no Mahnkosten yet" "$(dunning "$B")" "0.00 0.00"
pay "$B" 3
assert_eq "3 € more: the Mahngebühr first (§ 367 BGB)" "$(dunning "$B")" "3.00 0.00"
pay "$B" "$(python3 -c "print('%.2f' % (float('$FEE2') - 3 + float('$INT2')))")"
assert_eq "…the rest: the remaining fee, then the interest" "$(dunning "$B")" "$FEE2 $INT2"
assert_eq "…no credit from it" "$(credit)" "10.00"

note "--- an invoice overpaid twice: each payment credits its own excess ---"
invoice; F=$I
pay "$F" 1200
pay "$F" 5
assert_eq "1 190 € invoice, 1 200 € then 5 €: 15 € of credit (was: 10 + 15)" "$(PSQL "select coalesce(sum(amount), 0)::numeric(10,2) from \"CustomerCreditTransaction\" where \"companyId\"='$C' and type = 'overpayment' and \"referenceId\" in (select id from \"Payment\" where \"invoiceId\"='$F')")" "15.00"

note "=== 4. no Mahnung, or a cancelled one: as before ==="
invoice; D=$I
pay "$D" 1200
assert_eq "10 € beyond an invoice without a Mahnung: the customer's credit" "$(dunning "$D")/$(credit)" "0.00 0.00/35.00"
invoice; E=$I
mahnung "$E"; MID=$(PSQL "select id from \"Mahnung\" where \"invoiceId\"='$E'")
AS POST "/api/v1/reminders/mahnungen/$MID/cancel?$q" '{"reason":"Versehen"}'
pay "$E" 1200
assert_eq "…and beyond one whose Mahnung was cancelled" "$(dunning "$E")/$(credit)" "0.00 0.00/45.00"
summary
