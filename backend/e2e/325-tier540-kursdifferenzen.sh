#!/bin/bash
# Tier 540 — exchange differences are booked
#
# The "not covered" of Tier 505. An invoice over 1 085 USD is in the books at
# the rate of its day: 1 000 €. The customer's bank sends 990 € — or 1 010 €.
# Measured before: the reports counted 1 000 € either way (the EÜR 10 € more
# or less than the account shows), the DATEV file booked 1 000 € on the bank,
# and the payment kept no trace of what arrived.
#
# Now the payment keeps the euros received (`eurAmount`; from a EUR bank
# statement, or entered), and the difference to the invoice's rate is a
# Kursgewinn (EÜR 4190, SKR03 2660) or a Kursverlust (EÜR 5900, 2150). The VAT
# does not move (§ 16 Abs. 6 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-325-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier540-e2e\",\"companyName\":\"$TAG Export\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/exchange-rates/refresh" "{\"companyId\":\"$C\"}"
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"beraterNr":"12345","mandantenNr":"42"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Inc\",\"type\":\"business\",\"address\":{\"street\":\"1 Main St\",\"postalCode\":\"10001\",\"city\":\"New York\",\"country\":\"US\"}}"
K=$(json_field "$BODY" id)
usd() { # → id of an issued invoice over 1 085 USD
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"currency\":\"USD\",\"items\":[{\"description\":\"Software\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1085,\"vatRate\":0}]}"
  local id; id=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"
}
A=$(usd); B=$(usd); D=$(usd); E=$(usd)
assert_eq "fixture: 1 085 USD = 1 000 € at the invoice's rate" "$(q "select \"eurTotal\"::numeric(12,2) from \"Invoice\" where id='$A'")" "1000.00"
euer() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"; P "$1"; }
line() { echo "[l['amount'] for l in d['$1'] if l['kennziffer']=='$2'][0]"; }

MT=/tmp/t540-$TAG.mt940
cat > "$MT" <<'MT'
:1:F01BANKBICAXXX0000000000
:20:ST540
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR0,00
:61:2606100610C990,00NTRFNONREF//Zahlung A
Kunde
:86:166?00GUTSCHRIFT?20Zahlung A
:61:2606110611C1010,00NTRFNONREF//Zahlung B
Kunde
:86:166?00GUTSCHRIFT?20Zahlung B
:62F:C260611EUR2000,00
-
MT
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
rm -f "$MT"
SID=$(json_field "$UP" id)
txn() { echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==$1][0])"; }
match() { AS POST "/api/v1/bank-statements/$SID/transactions/$(txn "$1")/match?companyId=$C" "{\"invoiceId\":\"$2\"}"; }
pay() { q "select amount::numeric(12,2)||' '||coalesce(\"eurAmount\"::text,'-') from \"Payment\" where \"invoiceId\"='$1'"; }

note "=== 990 € arrive for 1 085 USD ==="
match 990 "$A"
assert_eq "matched: the invoice is paid" "$STATUS/$(q "select status from \"Invoice\" where id='$A'")" "201/paid"
assert_eq "the payment keeps the 990 € that arrived (was: no trace)" "$(pay "$A")" "1085.00 990.00"
assert_eq "the EÜR has a Kursverlust of 10 € (was 0)" "$(euer "(d['kursdifferenzen']['gewinn'], d['kursdifferenzen']['verlust'])")" "(0, 10)"
assert_eq "…in 5900, and the revenue stays 1 000 €" "$(euer "$(line ausgaben 5900)")/$(euer "d['totals']['einnahmenTotal']")" "10/1000"
assert_eq "…the Gewinn is the 990 € the account shows (was 1 000)" "$(euer "d['totals']['gewinn']")" "990"

note "=== 1 010 € arrive for 1 085 USD ==="
match 1010 "$B"
assert_eq "the payment keeps the 1 010 €" "$(pay "$B")" "1085.00 1010.00"
assert_eq "a Kursgewinn of 10 € beside the loss" "$(euer "(d['kursdifferenzen']['gewinn'], d['kursdifferenzen']['verlust'])")" "(10, 10)"
assert_eq "…in 4190; the Gewinn is 2 000 € — 990 + 1 010" "$(euer "$(line einnahmen 4190)")/$(euer "d['totals']['gewinn']")" "10/2000"

note "=== entered by hand ==="
AS POST "/api/v1/invoices/$D/payments?companyId=$C" '{"amount":1085,"paymentDate":"2026-06-15","paymentMethod":"bank_transfer","eurAmount":985.5}'
assert_eq "a payment of 1 085 USD with 985,50 € received: recorded" "$STATUS/$(pay "$D")" "201/1085.00 985.50"
assert_eq "…the loss is 24,50 € in all" "$(euer "d['kursdifferenzen']['verlust']")" "24.5"
AS POST "/api/v1/invoices/$E/payments?companyId=$C" '{"amount":1085,"paymentDate":"2026-06-16","paymentMethod":"bank_transfer"}'
assert_eq "a payment without the euros: at the invoice's rate, no difference" "$STATUS/$(pay "$E")/$(euer "d['kursdifferenzen']['verlust']")" "201/1085.00 -/24.5"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
EUR=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$EUR/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$EUR/payments?companyId=$C" '{"amount":100,"paymentDate":"2026-06-16","paymentMethod":"bank_transfer","eurAmount":99}'
assert_eq "a euro amount on a EUR invoice: 400" "$STATUS" "400"

note "=== DATEV ==="
curl -sS -o /tmp/t540.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-06-01&endDate=2026-06-30"
D_() { python3 - /tmp/t540.csv "$1" <<'PY'
import csv, io, sys
raw = open(sys.argv[1], 'rb').read()
rows = list(csv.reader(io.StringIO(raw.decode('cp1252')), delimiter=';', quotechar='"'))
cols = rows[1]
data = [dict(zip(cols, r)) for r in rows[2:] if r]
def row(text):
    m = [d for d in data if text in d['Buchungstext']]
    return ' '.join('%s|%s|%s|%s' % (d['Konto'], d['Gegenkonto (ohne BU-Schlüssel)'], d['Umsatz (ohne Soll/Haben-Kz)'], d['Soll/Haben-Kennzeichen']) for d in m) or '-'
def bank():
    t = 0.0
    for d in data:
        v = float(d['Umsatz (ohne Soll/Haben-Kz)'].replace('.', '').replace(',', '.'))
        if d['Konto'] == '1200': t += v if d['Soll/Haben-Kennzeichen'] == 'S' else -v
        if d['Gegenkonto (ohne BU-Schlüssel)'] == '1200': t -= v if d['Soll/Haben-Kennzeichen'] == 'S' else -v
    return '%.2f' % t
print(eval(sys.argv[2]))
PY
}
NA=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$A'"); NB=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$B'")
assert_eq "the loss: 2150 an Bank, 10 €" "$(D_ "row('Kursverlust $NA')")" "2150|1200|10,00|S"
assert_eq "the gain: Bank an 2660, 10 €" "$(D_ "row('Kursgewinn $NB')")" "1200|2660|10,00|S"
assert_eq "the bank account shows what arrived: 990 + 1 010 + 985,50 + 1 000 (was 4 000)" "$(D_ "bank()")" "3985.50"
rm -f /tmp/t540.csv

summary
