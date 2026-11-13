#!/bin/bash
# Tier 842 — the Kleinunternehmerregelung by date.
#
# Every report read Company.defaultVatMode as it is today, for every period.
# Measured on Tier 841: a Kleinunternehmer's 105 000 € moved from EÜR 4120
# (§ 19) to 4170 (steuerfrei) the moment the mode was set to `standard`; the
# other way, a company that became Kleinunternehmer lost the input tax of its
# regular years in the UStVA. Now the regulation has a period
# (Company.kleinunternehmerAb / kleinunternehmerBis) and each document is
# judged on its own date: the invoice's VAT, the § 19 line, the input tax.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1))
company() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e-536-$1-$(date +%s%N | cut -c1-13)@example.test\",\"password\":\"Tier842-e2e\",\"companyName\":\"e2e-536 $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
setup() {
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer","rechtsform":"Einzelunternehmen","besteuerungsart":"ist"}'
  assert_status 200 "fixture: a Kleinunternehmer (chosen for a new company: since always)"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
invoice() { # date net rate → TOTAL, paid on its date
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  local I; I=$(json_field "$BODY" id); TOTAL=$(py "print('%.2f' % float(d['total']))")
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":$TOTAL,\"paymentDate\":\"$1\",\"paymentMethod\":\"bank_transfer\"}"
  assert_status 201 "fixture: invoice of $1 paid ($TOTAL)"
}
expense() { # date net vat
  local gross; gross=$(python3 -c "print('%.2f' % ($2 + $3))")
  AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"Material\",\"invoiceNumber\":\"ER-$1\",\"invoiceDate\":\"$1\",\"netAmount\":$2,\"vatRate\":0.19,\"vatAmount\":$3,\"grossAmount\":$gross,\"category\":\"Büromaterial\",\"paidAt\":\"$1\"}"
  assert_status 201 "fixture: a bill of $1, $2 + $3 VAT"
}
euer() { # the year's 4100 / 4120 / 4170 / 4140 (USt received) / 5850 (Vorsteuer paid)
  AS GET "/api/v1/accounting/euer?companyId=$C&year=$1"
  py "a={l['kennziffer']:l['amount'] for l in d['einnahmen']+d['ausgaben']}; print(' '.join('%.2f' % a.get(k,0) for k in ('4100','4120','4170','4140','5850')))"
}
ustva() { # month → USt, Vorsteuer, sonstige steuerfreie Umsätze
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$P&month=$1"
  py "print('%.2f %.2f %.2f' % (d['umsatzsteuer'], d['vorsteuerSum'], d['otherExempt']))"
}

note "=== 1. a Kleinunternehmer until 30.06.$P, regular from 01.07.$P ==="
read -r U C < <(company ende); setup
expense "$P-03-02" 100 19
invoice "$P-03-02" 1000 0.19
assert_eq "an invoice of the Kleinunternehmer: no VAT" "$TOTAL" "1000.00"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"defaultVatMode\":\"standard\",\"kleinunternehmerBis\":\"$P-06-30\"}"
assert_status 200 "the switch to Regelbesteuerung from 01.07.$P (the supply that crossed the limit)"
assert_eq "…kept as the regulation's last day" "$(py "print(d['defaultVatMode'], (d.get('kleinunternehmerBis') or '')[:10])")" "standard $P-06-30"
invoice "$P-07-15" 1000 0.19
assert_eq "an invoice after it: with VAT" "$TOTAL" "1190.00"
invoice "$P-05-10" 1000 0.19
assert_eq "an invoice of 10.05. entered now: as the Kleinunternehmer then, no VAT (was 1 190)" "$TOTAL" "1000.00"
expense "$P-08-03" 200 38
assert_eq "EÜR $P: the two § 19 invoices stay on 4120, the regular one on 4100 with its USt; Vorsteuer only of August (was 2 000 on 4170, Vorsteuer 57)" \
  "$(euer $P)" "1000.00 2000.00 0.00 190.00 38.00"
assert_eq "UStVA 03/$P: no input tax of the Kleinunternehmer's bill (was 19)" "$(ustva 3)" "0.00 0.00 0.00"
assert_eq "UStVA 05/$P: the § 19 invoice is in no line (was 1 000 steuerfrei)" "$(ustva 5)" "0.00 0.00 0.00"
assert_eq "UStVA 07/$P: the regular invoice's 190" "$(ustva 7)" "190.00 0.00 0.00"
assert_eq "UStVA 08/$P: the bill's input tax" "$(ustva 8)" "0.00 38.00 0.00"

note "=== 2. the switch without a date keeps the past ==="
read -r U C < <(company ohne); setup
invoice "$P-02-02" 500 0
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"standard"}'
assert_status 200 "switched to Regelbesteuerung, no date given"
YESTERDAY=$(python3 -c "import datetime,zoneinfo;print((datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()-datetime.timedelta(days=1)).isoformat())")
assert_eq "§ 19 up to yesterday" "$(py "print((d.get('kleinunternehmerBis') or '')[:10])")" "$YESTERDAY"
assert_eq "EÜR $P: the 500 still § 19 revenue (was: on 4170)" "$(euer $P)" "0.00 500.00 0.00 0.00 0.00"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
assert_status 200 "back to Kleinunternehmer, no date given"
TODAY=$(python3 -c "import datetime,zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date().isoformat())")
assert_eq "…from the day after this year's end (a switch undone, no gap); 1 January otherwise" "$(py "print((d.get('kleinunternehmerAb') or '')[:10], (d.get('kleinunternehmerBis') or '')[:10])")" "$TODAY $YESTERDAY"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$P"
assert_eq "…and the 500 of $P still § 19" "$(euer $P)" "0.00 500.00 0.00 0.00 0.00"

note "=== 3. what is refused ==="
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"kleinunternehmerAb\":\"$P-01-01\"}"
assert_status 400 "a current period that begins before the end of the earlier one"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" "{\"closedUntil\":\"$P-12-31\"}"
assert_status 200 "fixture: the books of $P closed"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"kleinunternehmerBis\":\"$P-06-30\"}"
assert_status 400 "the regulation's end moved into the closed books"
echo "$BODY" | grep -q "Kleinunternehmerregelung" && pass "…the message says what was refused" || fail "…the message: $BODY"
summary
