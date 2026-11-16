#!/bin/bash
# Tier 846 — a bug hunt across the project (16.11.2026): the dunning letter's
# date, the Land's holidays, and requests that answered 500.
#
# Measured before:
#  - the letter of a Mahnung is rendered when it is downloaded and took the
#    day of the download: a Mahnung sent 30 days ago was dated today and
#    „überfällig seit 30 Werktagen (15 Kalendertagen)“, its Frist lying before
#    its date;
#  - the Werktage were counted with a table of their own: Bavaria's holidays
#    for every company, no Reformationstag, Easter only up to 2030;
#  - 32 kinds of odd values answered HTTP 500 instead of 400 (a probe of
#    8 400 requests on the write endpoints): `1e-9` as a price or an exchange
#    rate, a date that does not exist, `null` for a field that takes none, a
#    list as the body, numbers beyond their column.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F)
TAG="e2e-540-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier846-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"
q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"email":"info@t540.example.test","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
CU="{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
AS POST "/api/v1/customers?$q" "$CU"; K=$(json_field "$BODY" id)

note "=== 1. the letter of a Mahnung bears the day it was sent ==="
ISS=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=75)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=45)).isoformat())")
INV="{\"customerId\":\"$K\",\"issueDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?$q" "$INV"; I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
SEND="{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"first\"}"
AS POST "/api/v1/reminders/send" "$SEND"
assert_status 201 "fixture: a Zahlungserinnerung, 45 days after the due date"
MID=$(json_field "$BODY" mahnungId)
# sent 30 days ago: every stored day of the Mahnung 30 days back
PSQL "update \"Mahnung\" set \"sentAt\" = \"sentAt\" - interval '30 days', \"createdAt\" = \"createdAt\" - interval '30 days', \"neueFrist\" = \"neueFrist\" - interval '30 days', \"daysOverdue\" = \"daysOverdue\" - 30 where id='$MID'" >/dev/null
SENT=$(PSQL "select to_char(\"sentAt\" at time zone 'Europe/Berlin', 'DD.MM.YYYY') from \"Mahnung\" where id='$MID'")
curl -sS -o /tmp/t540-m.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reminders/mahnungen/$MID/pdf?$q"
TXT=$(pdf_text /tmp/t540-m.pdf | tr -s ' \n' ' ')
WANT=$(python3 - "$DUE" <<'PY'
import datetime, sys
due = datetime.date.fromisoformat(sys.argv[1]); sent = datetime.date.today() - datetime.timedelta(days=30)
def easter(y):
    a=y%19; b=y//100; c=y%100; d=b//4; e=b%4; f=(b+8)//25; g=(b-f+1)//3; h=(19*a+b-d-g+15)%30; i=c//4; k=c%4
    l=(32+2*e+2*i-h-k)%7; m=(a+11*h+22*l)//451; return datetime.date(y,(h+l-7*m+114)//31,(h+l-7*m+114)%31+1)
def holiday(x):  # nationwide (the company has no Land)
    e = easter(x.year); fixed = {(1,1),(5,1),(10,3),(12,25),(12,26)}
    return (x.month, x.day) in fixed or x in {e+datetime.timedelta(days=n) for n in (-2,1,39,50)}
n = 0; x = due + datetime.timedelta(days=1)
while x < sent:
    if x.weekday() < 5 and not holiday(x): n += 1
    x += datetime.timedelta(days=1)
print(n)
PY
)
[[ "$TXT" == *"$SENT"* ]] && pass "the letter is dated the day it was sent, $SENT (was: the day of the download)" || fail "letter date $SENT not in: ${TXT:0:300}"
[[ "$TXT" != *"$(TZ=Europe/Berlin date +%d.%m.%Y)"* ]] && pass "…and today's date is nowhere in it" || fail "today's date is in the letter: ${TXT:0:300}"
[[ "$TXT" == *"Überfällig seit $WANT Werktagen (15 Kalendertagen)"* ]] && pass "überfällig seit $WANT Werktagen (15 Kalendertagen) — both of the day it was sent (was: 30 Werktage beside 15 Kalendertage)" \
  || fail "expected „Überfällig seit $WANT Werktagen (15 Kalendertagen)“ in: $(echo "$TXT" | grep -o 'Überfällig seit[^.]*\.')"

note "=== 2. Werktage: the holidays of the company's Land ==="
assert_eq "29.10. – 03.11.2027: 1 Werktag in BY (Allerheiligen), 2 in BE and without a Land; Karfreitag 2031 and the Reformationstag in BB are none (was: 1 for every Land, both Werktage)" \
  "$(cd "$SCRIPT_DIR/.." && npx ts-node scripts/probe-werktage.ts 2>&1 | tail -1)" "1 2 2 false false"

note "=== 3. odd values are refused with 400, not answered with 500 ==="
code() { # method path body → HTTP status
  curl -sS -o /tmp/t540.json -w "%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$3"
}
PRODUCT='{"name":"Ware","basePrice":10,"vatRate":0.19,"unit":"Stk"}'
AS POST "/api/v1/products?$q" "$PRODUCT"; PR=$(json_field "$BODY" id)
B='{"name":"Ware 2","basePrice":1e-9}';                     assert_eq "a product priced 1e-9 (was 500: the decimal-places check threw)" "$(code POST "/api/v1/products?$q" "$B")" "400"
B='{"name":"Ware 3","basePrice":10,"vatRate":1e-9}';        assert_eq "…a VAT rate of 1e-9" "$(code POST "/api/v1/products?$q" "$B")" "400"
B='{"name":"Ware 4","basePrice":99999999999999999999}';     assert_eq "a price beyond the column (was 500: numeric overflow)" "$(code POST "/api/v1/products?$q" "$B")" "400"
B='{"name":"Ware 5","basePrice":10,"stockQuantity":1e308}'; assert_eq "…a stock beyond it" "$(code POST "/api/v1/products?$q" "$B")" "400"
B='{"name":"Ware 6","basePrice":10,"unit":null,"vatRate":null,"stockQuantity":null,"trackInventory":null}'
assert_eq "null where a default applies: the product is created with the defaults (was 500)" \
  "$(code POST "/api/v1/products?$q" "$B")/$(python3 -c "import json;d=json.load(open('/tmp/t540.json'));print(d.get('unit'), float(d.get('vatRate')), float(d.get('stockQuantity')), d.get('trackInventory'))")" "201/piece 0.19 0.0 False"
assert_eq "a list as the body of a product update (was 500)" "$(code PUT "/api/v1/products/$PR?$q" '[]')" "400"
assert_eq "…of a customer update" "$(code PUT "/api/v1/customers/$K?$q" '[]')" "400"
assert_eq "…of the company" "$(code PUT "/api/v1/companies/$C?$q" '[]')" "400"
assert_eq "a customer's name set to null (was 500)" "$(code PUT "/api/v1/customers/$K?$q" '{"name":null}')" "400"
assert_eq "…its type" "$(code PUT "/api/v1/customers/$K?$q" '{"type":null}')" "400"
assert_eq "a credit limit beyond the column (was 500)" "$(code PUT "/api/v1/customers/$K?$q" '{"creditLimit":99999999999999999999}')" "400"
assert_eq "the company's payment term set to null: left as it was (was 500)" \
  "$(code PUT "/api/v1/companies/$C?$q" '{"defaultPaymentDays":null}')/$(PSQL "select \"defaultPaymentDays\" from \"Company\" where id='$C'")" "200/30"
REC() { echo "{\"customerId\":\"$K\",\"name\":\"Wartung\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"$1\"${2:-},\"items\":[{\"description\":\"W\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":100,\"vatRate\":0.19}]}"; }
assert_eq "a recurring template starting 2026-13-01 (was 500: an Invalid Date)" "$(code POST "/api/v1/recurring-invoices?$q" "$(REC 2026-13-01)")" "400"
assert_eq "…starting 0000-00-00" "$(code POST "/api/v1/recurring-invoices?$q" "$(REC 0000-00-00)")" "400"
assert_eq "…starting 9999-12-31" "$(code POST "/api/v1/recurring-invoices?$q" "$(REC 9999-12-31)")" "400"
assert_eq "…every 100 000 months (was 500: the next run past the year 9999)" "$(code POST "/api/v1/recurring-invoices?$q" "$(REC "$TODAY" ',"intervalCount":100000')")" "400"
assert_eq "…and a regular one is still created" "$(code POST "/api/v1/recurring-invoices?$q" "$(REC "$TODAY" ',"intervalCount":3')")" "201"
TE() { echo "{\"customerId\":\"$K\",\"date\":\"$1\",\"minutes\":60,\"description\":\"Arbeit\",\"hourlyRate\":80}"; }
assert_eq "a time entry dated 2026-13-01 (was 500: toISOString() threw)" "$(code POST "/api/v1/time-entries?$q" "$(TE 2026-13-01)")" "400"
assert_eq "…and one of today is created" "$(code POST "/api/v1/time-entries?$q" "$(TE "$TODAY")")" "201"
EXP="{\"description\":\"Büro\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119,\"category\":\"Büro\"}"
AS POST "/api/v1/expenses?$q" "$EXP"; E=$(json_field "$BODY" id)
assert_eq "an expense's description set to null (was 500)" "$(code PUT "/api/v1/expenses/$E?$q" '{"description":null}')" "400"
CASH="{\"businessDate\":\"$TODAY\",\"type\":\"einnahme\",\"description\":\"Tageslosung\",\"amount\":50,\"vatRate\":0.19}"
AS POST "/api/v1/cashbook/entries?$q" "$CASH"; CE=$(json_field "$BODY" id)
assert_eq "a cash book entry's amount set to null (was 500)" "$(code PUT "/api/v1/cashbook/entries/$CE?$q" '{"amount":null}')" "400"
assert_eq "…to more than the column holds (was 500)" "$(code PUT "/api/v1/cashbook/entries/$CE?$q" '{"amount":99999999999999999999}')" "400"
assert_eq "…its description to null" "$(code PUT "/api/v1/cashbook/entries/$CE?$q" '{"description":null}')" "400"
V="{\"companyId\":\"\",\"date\":\"$TODAY\",\"description\":\"Umbuchung\",\"status\":\"draft\",\"lines\":[{\"description\":\"a\",\"debit\":100,\"credit\":0},{\"description\":\"b\",\"debit\":0,\"credit\":100}]}"
assert_eq "a voucher without a company (was 500)" "$(code POST "/api/v1/accounting/vouchers?$q" "$V")" "400"
FX="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"currency\":\"USD\",\"exchangeRate\":1e-9,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_eq "an invoice with the exchange rate 1e-9 (was 500)" "$(code POST "/api/v1/invoices?$q" "$FX")" "400"
FX="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"currency\":\"USD\",\"exchangeRate\":1.0875,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_eq "…and one at 1.0875 is created" "$(code POST "/api/v1/invoices?$q" "$FX")" "201"
rm -f /tmp/t540.json /tmp/t540-m.pdf
summary
