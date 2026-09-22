#!/bin/bash
# Tier 423 — a DATEV Buchungsstapel DATEV can import
#
# Measured before, on the same data:
#   header  "EXTF";"Buchungsstapel";"15";… (25 fields of its own design);
#           no column-heading line; every data row began with "EXTF", the
#           amount sat in column 9 with a decimal point — DATEV reads by
#           position, so nothing landed in its column
#   an unpaid invoice was not exported at all (only status 'paid'); a paid
#           one was booked on the payment date, on 1406 instead of the
#           customer's account, net on 8400 plus a second row for the tax
#   credit notes and partial payments were missing
#   the expense was booked "Bank an Aufwand" (paid or not) plus a
#           Vorsteuer row, with the invented key "1"/"12"
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-212-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
FROM=$(date +%Y-%m-01)
TO=$(python3 -c "import datetime,calendar;d=datetime.date.today();print(d.replace(day=calendar.monthrange(d.year,d.month)[1]).isoformat())")
TTMM=$(date +%d%m)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier423-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"beraterNr":"12345","mandantenNr":"42"}'
[[ "$STATUS" == 200 ]] || fail "datev-config: $STATUS $BODY"

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Inland\",\"type\":\"business\",\"address\":{\"street\":\"Weg 1\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K1=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Paris\",\"type\":\"business\",\"vatId\":\"FR40303265045\",\"address\":{\"street\":\"Rue 1\",\"city\":\"Paris\",\"postalCode\":\"75001\",\"country\":\"FR\"}}"
K2=$(json_field "$BODY" id)
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"Str 2\",\"city\":\"Bonn\",\"postalCode\":\"53111\",\"country\":\"DE\"}}"
S1=$(json_field "$BODY" id)

sent() { # customer, extra, items → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"$2,\"items\":[$3]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
A=$(sent "$K1" "" '{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}')
B=$(sent "$K2" ',"euTransaction":true' '{"description":"Lieferung","quantity":1,"unit":"Stk","unitPrice":500,"vatRate":0}')
AS POST "/api/v1/invoices/$A/payments?companyId=$C" "{\"amount\":500,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"amount":119}'
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$S1\",\"invoiceNumber\":\"ER-77\",\"description\":\"Büromaterial\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"invoiceNumber\":\"ER-78\",\"description\":\"Subunternehmer Bau\",\"invoiceDate\":\"$TODAY\",\"netAmount\":2000,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":2000,\"isReverseCharge\":true}"
# A manual voucher with a separate Vorsteuer line: Aufwand 100 + VSt 19 an Bank 119.
acc() { AS POST "/api/v1/accounting/accounts?companyId=$C" "{\"accountNumber\":\"$1\",\"name\":\"$2\",\"type\":\"$3\"}"; json_field "$BODY" id; }
A4900=$(acc 4900 Aufwand expense); A1576=$(acc 1576 Vorsteuer asset); A1200=$(acc 1200 Bank asset)
AS POST "/api/v1/accounting/vouchers" "{\"companyId\":\"$C\",\"date\":\"$TODAY\",\"description\":\"Tankquittung\",\"referenceType\":\"Manual\",\"status\":\"posted\",\"lines\":[
  {\"accountId\":\"$A4900\",\"debit\":100,\"credit\":0,\"description\":\"Tankquittung\"},
  {\"accountId\":\"$A1576\",\"debit\":19,\"credit\":0,\"description\":\"VSt Tankquittung\",\"vatRate\":0.19,\"vatAmount\":19},
  {\"accountId\":\"$A1200\",\"debit\":0,\"credit\":119,\"description\":\"Bank\"}]}"
[[ "$STATUS" == 201 ]] || fail "voucher: $STATUS $BODY"
INV_A=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"invoiceNumber\" from \"Invoice\" where id='$A'")

export_csv() {
  curl -sS -o "$1" -H "x-user-id: $U" -H "x-company-id: $C" \
    "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TO"
}
export_csv /tmp/t423.csv
# Parse as DATEV does: Windows-1252, ";" with '"' quotes, by column heading.
P() { python3 - /tmp/t423.csv "$1" <<'PY'
import csv, io, sys
raw = open(sys.argv[1], 'rb').read()
rows = list(csv.reader(io.StringIO(raw.decode('cp1252')), delimiter=';', quotechar='"'))
hdr, cols = rows[0], rows[1]
data = [dict(zip(cols, r)) for r in rows[2:] if r]
def row(text):
    m = [d for d in data if text in d['Buchungstext']]
    return ' '.join('%s|%s|%s|%s|%s|%s' % (d['Konto'], d['Gegenkonto (ohne BU-Schlüssel)'], d['Umsatz (ohne Soll/Haben-Kz)'],
        d['Soll/Haben-Kennzeichen'], d['BU-Schlüssel'], d['Belegdatum']) for d in m) or '-'
print(eval(sys.argv[2]))
PY
}

note "=== 1. the file ==="
assert_eq "header: EXTF 700, category 21, Buchungsstapel, version 13" "$(P "'/'.join(hdr[:5])")" "EXTF/700/21/Buchungsstapel/13"
assert_eq "header: 31 fields, Berater 12345, Mandant 42, Sachkontenlänge 4" "$(P "'%d %s %s %s' % (len(hdr), hdr[10], hdr[11], hdr[13])")" "31 12345 42 4"
assert_eq "header: period and fiscal-year start" "$(P "' '.join(hdr[12:16:1][:1] + hdr[14:16])")" "$(date +%Y)0101 ${FROM//-/} ${TO//-/}"
assert_eq "line 2: DATEV's 125 column headings" "$(P "'%d %s' % (len(cols), cols[0])")" "125 Umsatz (ohne Soll/Haben-Kz)"
assert_eq "every row has 125 fields" "$(P "sorted(set(len(r) for r in rows[1:] if r))")" "[125]"
python3 -c "import sys;d=open('/tmp/t423.csv','rb').read();sys.exit(0 if b'KOST1 \x96 Kostenstelle' in d else 1)" \
  && pass "Windows-1252: the heading's '–' is byte 0x96" || fail "encoding"

note "=== 2. invoices at their issue date, on the customer's own account ==="
assert_eq "unpaid 19 % part: Debitor 10000 an 8400, gross 1190,00 S, key 3 (was: not exported)" \
  "$(P "row('Rechnung $INV_A')")" "10000|8400|1190,00|S|3|$TTMM 10000|8300|107,00|S|2|$TTMM"
assert_eq "igL: second Debitor 10001 an 8125, no key, VAT id for the ZM" \
  "$(P "row('Rechnung ') .split(' ')[-1] + ' ' + [d for d in data if d['Konto']=='10001'][0]['EU-Land u. USt-IdNr.']")" \
  "10001|8125|500,00|S||$TTMM FR40303265045"
# The 119 € credit note is split over the invoice's rates (Tier 416).
assert_eq "credit note: 10000 an 8400 / 8300, H, keys 3 / 2 (was: missing)" "$(P "row('Gutschrift')")" \
  "10000|8400|109,18|H|3|$TTMM 10000|8300|9,82|H|2|$TTMM"
assert_eq "partial payment: Bank 1200 an 10000, 500,00 S (was: missing)" "$(P "row('Zahlung $INV_A')")" "1200|10000|500,00|S||$TTMM"
assert_eq "no separate tax rows, no collective account" "$(P "sum(1 for d in data if d['Konto'] in ('1406','1400') or d['Gegenkonto (ohne BU-Schlüssel)'] in ('1776','1771','1760'))")" "0"

note "=== 3. expenses on the supplier's account ==="
assert_eq "expense: Kreditor 70001 an 4900, gross 119,00 H, key 9 (was Bank, key 1)" "$(P "row('Büromaterial')")" "70001|4900|119,00|H|9|$TTMM"
assert_eq "§ 13b without supplier: Diverse Kreditoren 70000, net, key 94 (was 12)" "$(P "row('Subunternehmer')")" "70000|4900|2000,00|H|94|$TTMM"

note "=== 4. a voucher is one booking, not one per line ==="
assert_eq "Bank 1200 an 4900, 119,00 H, key 9 — the tax line folded in (was 3 rows, 2 of them duplicates)" \
  "$(P "row('Tankquittung')")" "1200|4900|119,00|H|9|$TTMM"

note "=== 5. the accounts stay ==="
assert_eq "stored on the customer and supplier" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(\"datevAccount\"::text, ',' order by \"datevAccount\") from (select \"datevAccount\" from \"Customer\" where \"companyId\"='$C' union all select \"datevAccount\" from \"Supplier\" where \"companyId\"='$C') x")" \
  "10000,10001,70001"
export_csv /tmp/t423b.csv
assert_eq "a second export books on the same accounts" "$(diff <(cut -d';' -f7-8 /tmp/t423.csv | tail -n +3) <(cut -d';' -f7-8 /tmp/t423b.csv | tail -n +3) && echo same)" "same"

summary; exit $?
