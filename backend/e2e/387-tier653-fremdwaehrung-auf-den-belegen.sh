#!/bin/bash
# Tier 653 — what the customer gets for an invoice in a foreign currency says
# that currency; what the company adds up is in euros
#
# Found while reconciling a USD invoice by hand (Tier 652). The invoice form
# has offered a currency since Tier 118, and the tax reports convert it — but
# everything printed for the customer wrote "€":
#   - the invoice PDF: "Gesamtbetrag: € 11.900,00" for 11 900 USD (10 619 €),
#     with a GiroCode that paid 11 900 EUR;
#   - the reminder e-mail: "noch 2.380,00 EUR offen" for 2 380 USD;
#   - the Mahnung: every amount with "€", and a fee of 5 € added to dollars;
#   - the statement: USD, SEK and CHF invoices in one column and one balance,
#     in "€".
# And what the company adds up was not in euros: the aging report and the
# sum of what is overdue added 2 380 USD to 1 190 EUR and called it 3 570 €.
# The e-invoice named USD but gave no VAT amount in euros (BT-6 / BT-111;
# Art. 230 MwStSystRL wants the VAT in the national currency).
#
# The test backend runs with fixed rates: 1 EUR = 1.0850 USD on every day.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-387-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
GETF() { curl -sS -o "$2" -w "%{http_code}" "$API$1" -H "x-user-id: $U" -H "x-company-id: $C"; }
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
day() { python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$1)).isoformat())"; }
# The text of a PDF written with the built-in fonts: the strings of its TJ
# operators.
cat > "$TMP/pdftext.py" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
out = []
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
    try: t = zlib.decompress(m.group(1))
    except Exception: continue
    for arr in re.findall(rb'\[((?:<[0-9a-fA-F]*>|[-0-9. ]+)+)\]\s*TJ', t):
        out.append(b''.join(bytes.fromhex(h.decode()) for h in re.findall(rb'<([0-9a-fA-F]*)>', arr)).decode('cp1252', 'replace'))
# (a non-breaking space stands between an amount and its currency)
print('\n'.join(out).replace('\u00a0', ' '))
PY
TEXT() { python3 "$TMP/pdftext.py" "$1"; }
[[ "${EXCHANGE_RATES_MOCK:-}" == "1" ]] || { note "EXCHANGE_RATES_MOCK is not 1 — the fixed rates are needed"; summary; exit 0; }
TODAY=$(TZ=Europe/Berlin date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier653-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" "DE123456789"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Commerzbank"}}'
assert_eq "fixture: the company has an IBAN" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Importhaus Nord GmbH","type":"business","contact":{"email":"einkauf@importhaus.example"},"address":{"street":"Hafenweg 3","postalCode":"20457","city":"Hamburg","country":"DE"}}'; K=$(field "d['id']")
inv() { # currency price issue due
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$3'","dueDate":"'$4'","currency":"'$1'","items":[{"description":"Lederwaren","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]}'
  local id; id=$(field "d['id']")
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}' >/dev/null
  echo "$id"
}
I1=$(inv USD 10000 "$TODAY" 2099-12-31)   # 11 900 USD = 10 967,74 €
I2=$(inv USD 2000 "$(day 60)" "$(day 46)") #  2 380 USD =  2 193,55 €, overdue
I3=$(inv EUR 1000 "$(day 60)" "$(day 46)") #  1 190 €, overdue
[[ -n "$I1" && -n "$I2" && -n "$I3" ]] && pass "fixture: 11 900 USD today, 2 380 USD and 1 190 EUR overdue" || { fail "invoices"; summary; exit 1; }

note "=== 1. the invoice ==="
assert_eq "the PDF of the USD invoice" "$(GETF "/api/v1/invoices/$I1/pdf?companyId=$C" "$TMP/usd.pdf")" "200"
TEXT "$TMP/usd.pdf" > "$TMP/usd.txt"
grep -q "11.900,00 USD" "$TMP/usd.txt" && pass "its total is 11.900,00 USD" || fail "no '11.900,00 USD' in the PDF"
assert_eq "no amount with a euro sign but the euro note (was: € 10.000,00, € 1.900,00, € 11.900,00)" "$(grep -c "€" "$TMP/usd.txt")" "1"
grep -q "Umsatzsteuer in Euro: € 1.751,15" "$TMP/usd.txt" && pass "the VAT in euros: 1 900 / 1,0850 = 1 751,15" || fail "no VAT in euros: $(grep -i euro "$TMP/usd.txt")"
grep -q "Gesamtbetrag in Euro: € 10.967,74" "$TMP/usd.txt" && pass "the total in euros: 10 967,74" || fail "no total in euros"
grep -q "1 EUR = 1,0850 USD (EZB-Referenzkurs vom" "$TMP/usd.txt" && pass "the rate and where it is from" || fail "no rate: $(grep -i kurs "$TMP/usd.txt")"
assert_eq "no GiroCode for dollars (it paid 11 900 EUR)" "$(GETF "/api/v1/invoices/$I1/girocode.png?companyId=$C" "$TMP/giro.out")" "404"
grep -q "in Euro" "$TMP/giro.out" && grep -q "USD" "$TMP/giro.out" && pass "… and the answer says why" || fail "GiroCode answer: $(cat "$TMP/giro.out")"
grep -aq "/Subtype */Image" "$TMP/usd.pdf" && fail "the USD invoice's PDF carries an image (a GiroCode?)" || pass "the PDF carries no code either"
assert_eq "the EUR invoice keeps its GiroCode" "$(GETF "/api/v1/invoices/$I3/girocode.png?companyId=$C" "$TMP/giro.png")" "200"
GETF "/api/v1/invoices/$I3/pdf?companyId=$C" "$TMP/eur.pdf" >/dev/null; TEXT "$TMP/eur.pdf" > "$TMP/eur.txt"
grep -q "€ 1.190,00" "$TMP/eur.txt" && ! grep -q "Umsatzsteuer in Euro\|USD" "$TMP/eur.txt" \
  && pass "an EUR invoice is as it was: € 1.190,00, no euro note" || fail "EUR invoice PDF changed"

note "=== 2. the e-invoice ==="
GETF "/api/v1/invoices/$I1/xrechnung?companyId=$C" "$TMP/usd.xml" >/dev/null
assert_eq "BT-5 and BT-6: the invoice in USD, the VAT accounted for in EUR" \
  "$(grep -o '<cbc:\(Document\|Tax\)CurrencyCode>[A-Z]*' "$TMP/usd.xml" | sed 's/.*>//' | tr '\n' ' ')" "USD EUR "
assert_eq "BT-110 in USD, BT-111 in EUR" \
  "$(python3 -c "
import re,sys
t=open(sys.argv[1],encoding='utf-8').read()
print(re.findall(r'<cac:TaxTotal>\s*<cbc:TaxAmount currencyID=\"([A-Z]+)\">([0-9.]+)', t))" "$TMP/usd.xml")" "[('USD', '1900.00'), ('EUR', '1751.15')]"
GETF "/api/v1/invoices/$I3/xrechnung?companyId=$C" "$TMP/eur.xml" >/dev/null
assert_eq "an EUR invoice has no tax currency and one tax total" "$(grep -c 'TaxCurrencyCode' "$TMP/eur.xml")/$(grep -c '<cac:TaxTotal>' "$TMP/eur.xml")" "0/1"
AS GET "/api/v1/invoices/$I1/xrechnung/validate?companyId=$C"
assert_eq "the USD e-invoice passes the built-in rules" "$(field "d['valid']")" "True"
# the CII of the ZUGFeRD PDF is built from the same data
grep -q "ram:TaxCurrencyCode" "$SCRIPT_DIR/../src/invoices/zugferd.service.ts" \
  && grep -q 'TaxTotalAmount currencyID="${escapeXml(data.taxCurrency.code)}"' "$SCRIPT_DIR/../src/invoices/zugferd.service.ts" \
  && pass "the CII carries the tax currency and its total too" || fail "zugferd.service.ts has no tax currency"

note "=== 3. the reminder ==="
AS GET "/api/v1/reminders/overdue?companyId=$C"
assert_eq "the overdue list names each invoice's currency" \
  "$(field "sorted((x['openAmount'], x.get('currency')) for x in d)")" "[('1190', 'EUR'), ('2380', 'USD')]"
AS GET "/api/v1/reminders/stats?companyId=$C"
assert_eq "what is overdue, in euros: 2 380 USD / 1,0850 + 1 190 = 3 383,55 (was 3 570)" "$(field "d['totalOverdueAmount']")" "3383.55"
AS GET "/api/v1/reminders/$I2/email-data?companyId=$C&level=first"
echo "$BODY" | grep -q "noch 2.380,00 USD offen" && ! echo "$BODY" | grep -q "2.380,00 EUR" \
  && pass "the e-mail asks for 2.380,00 USD (was: 2.380,00 EUR)" || fail "e-mail: $(field "d['body']" | head -3)"
AS GET "/api/v1/reminders/$I3/email-data?companyId=$C&level=first"
echo "$BODY" | grep -q "noch 1.190,00 EUR offen" && pass "… and for 1.190,00 EUR on the EUR invoice" || fail "EUR e-mail changed"
# a text of the company's own, with the sign before the amount
AS PUT "/api/v1/reminders/templates/first?companyId=$C" '{"subject":"Erinnerung {{invoiceNumber}}","body":"Offen: € {{openAmount}} von {{invoiceTotal}}€ ({{currency}})."}'
assert_eq "the company writes its own text" "$STATUS" "200"
AS GET "/api/v1/reminders/$I2/email-data?companyId=$C&level=first"
assert_eq "its euro signs become the invoice's currency" "$(field "d['body']")" "Offen: 2.380,00 USD von 2.380,00 USD (USD)."
AS GET "/api/v1/reminders/$I3/email-data?companyId=$C&level=first"
assert_eq "… and stay for an EUR invoice" "$(field "d['body']")" "Offen: € 1.190,00 von 1.190,00€ (EUR)."

note "=== 4. the Mahnung ==="
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I2&level=final"
assert_eq "the fee of 10 € is asked for in dollars: 10,85 USD" "$(field "(d['currency'], d['mahngebuehr'], d['openBalance'])")" "('USD', 10.85, 2380)"
assert_eq "one sum in one currency" "$(field "round(d['totalDue'] - d['openBalance'] - d['mahngebuehr'] - d['verzugszins'], 2)")" "0.0"
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I3&level=final"
assert_eq "an EUR invoice: 10 €" "$(field "(d['currency'], d['mahngebuehr'])")" "('EUR', 10)"
AS POST "/api/v1/reminders/send" '{"companyId":"'$C'","invoiceId":"'$I2'","level":"final"}'
M=$(field "d['mahnungId']")
assert_eq "the Mahnung is sent" "$STATUS $([[ -n "$M" ]] && echo id)" "201 id"
GETF "/api/v1/reminders/mahnungen/$M/pdf?companyId=$C" "$TMP/mahnung.pdf" >/dev/null; TEXT "$TMP/mahnung.pdf" > "$TMP/mahnung.txt"
grep -q "Offener Betrag: 2.380,00 USD" "$TMP/mahnung.txt" && pass "the letter: Offener Betrag 2.380,00 USD" || fail "letter: $(grep -i offener "$TMP/mahnung.txt")"
grep -q "10,85 USD" "$TMP/mahnung.txt" && grep -q "in USD zum Kurs der Rechnung" "$TMP/mahnung.txt" \
  && pass "… the fee 10,85 USD, and how it came about" || fail "no fee in USD: $(grep -i mahngeb "$TMP/mahnung.txt")"
assert_eq "… and no euro sign in it (was: after every amount)" "$(grep -c "€" "$TMP/mahnung.txt")" "0"

note "=== 5. the statement ==="
Y=${TODAY:0:4}
AS GET "/api/v1/customers/$K/statement?companyId=$C&from=$(day 90)&to=$TODAY"
assert_eq "the statement is the EUR one, and names the other (was: one balance of 15 470 \"€\")" \
  "$(field "(d['currency'], d['currencies'], len(d['lines']), d['closingBalance'])")" "('EUR', ['EUR', 'USD'], 1, 1190)"
AS GET "/api/v1/customers/$K/statement?companyId=$C&from=$(day 90)&to=$TODAY&currency=USD"
assert_eq "the USD statement: two invoices, 14 280 USD" "$(field "(d['currency'], len(d['lines']), d['closingBalance'])")" "('USD', 2, 14280)"
AS GET "/api/v1/customers/$K/statement?companyId=$C&from=$(day 90)&to=$TODAY&currency=Dollar"
assert_eq "\"Dollar\" is not a currency" "$STATUS" "400"
GETF "/api/v1/customers/$K/statement.pdf?companyId=$C&from=$(day 90)&to=$TODAY&currency=USD" "$TMP/stmt.pdf" >/dev/null; TEXT "$TMP/stmt.pdf" > "$TMP/stmt.txt"
grep -q "14.280,00 USD" "$TMP/stmt.txt" && pass "its PDF closes with 14.280,00 USD" || fail "statement PDF: $(tail -5 "$TMP/stmt.txt")"
grep -q "umfasst die Posten in USD" "$TMP/stmt.txt" && grep -q "Für EUR gibt es" "$TMP/stmt.txt" && pass "… and says that EUR has a statement of its own" || fail "no note about the other currency"
assert_eq "… without a euro sign" "$(grep -c "€" "$TMP/stmt.txt")" "0"

note "=== 6. what the company adds up ==="
AS GET "/api/v1/reports/aging?companyId=$C"
# 10 967,74 (not yet due) + 2 193,55 + 1 190,00 (overdue 31–60 days)
assert_eq "the aging report in euros (was 15 470: dollars and euros added)" \
  "$(field "(d['totals']['current'], d['totals']['31-60'], d['grandTotal'])")" "(10967.74, 3383.55, 14351.29)"

summary
