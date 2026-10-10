#!/bin/bash
# Tier 641 — another member state's tax is not German tax, and a credited sale
# leaves the OSS report
#
# The OSS report reconciled against the UStVA. Sales to consumers in France and
# Austria at those states' rates (20 %, 5,5 %), a sale to a consumer at home,
# an intra-EU supply to a business. Measured:
#   GET /ustva/compute  → Kz 35 = 430,00 and Kz 36 = 78,75: the French and the
#        Austrian tax as "steuerpflichtige Umsätze zu anderen Steuersätzen",
#        German tax to pay — 135,75 where 57,00 were owed; the same 78,75 are
#        in the OSS report, to be paid at the BZSt.
#   GET /reports/oss    → a sale credited in full stayed in it with its tax
#        (credit notes were left out), and the credit note's −16 € lowered the
#        *German* tax of the month it was written in.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-378-$(date +%s%N | cut -c1-13)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
customer() { # name type country [vatId] → prints id (subshell: use only the output)
  local resp; resp=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"name":"'"$1"'","type":"'$2'","address":{"street":"Weg 1","postalCode":"1000","city":"Ort","country":"'$3'"}'"${4:+,\"vatId\":\"$4\"}"'}')
  json_field "$resp" id
}
invoice() { # customer date net rate [extra] → I, issued
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$1'","issueDate":"'$2'","dueDate":"2099-12-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'$3',"vatRate":'$4'}]'"${5:+,$5}"'}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
kz() { field "sorted((k['kz'], k['value'], k.get('tax')) for k in d['kennzahlen'] if k['kz'] in ('81','86','35','36','41','83') and (k['value'] or k.get('tax')))"; }
ustva() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; }
oss() { AS GET "/api/v1/reports/oss?companyId=$C&year=$1&quarter=$2"; }
lines() { field "sorted((c['country'], l['vatRate'], l['netAmount'], l['vatAmount'], l['invoiceCount']) for c in d['countries'] for l in c['vatRates'])"; }

# today, and a day in the quarter before this one (German calendar)
read -r TODAY Y M Q EARLY Y0 M0 Q0 < <(TZ=Europe/Berlin python3 -c "
import datetime
t=datetime.date.today(); q=(t.month-1)//3+1
e=datetime.date(t.year,3*(q-1)+1,1)-datetime.timedelta(days=20)
print(t.isoformat(),t.year,t.month,q,e.isoformat(),e.year,e.month,(e.month-1)//3+1)")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier641-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
FR=$(customer "Marie Dupont" individual FR); AT=$(customer "Hans Huber" individual AT)
DE=$(customer "Erika Privat" individual DE); FRB=$(customer "Client SARL" business FR FR40303265045)
invoice "$FR" "$EARLY" 100 0.20;  F1=$I
invoice "$FR" "$EARLY" 50 0.055
invoice "$AT" "$EARLY" 200 0.20
invoice "$DE" "$EARLY" 300 0.19
invoice "$FRB" "$EARLY" 400 0 '"euTransaction":true'
invoice "$FR" "$EARLY" 80 0.20;   F3=$I
[[ -n "$F1" && -n "$F3" ]] && pass "fixture: six invoices on $EARLY — three consumers abroad, one at home, one business in France" || fail "fixture: $BODY"

note "=== 1. the month of the sales ==="
ustva "$Y0" "$M0"
assert_eq "the UStVA has the German sale and the intra-EU supply — no Kz 35 / 36 (was: 430,00 / 78,75 of French and Austrian tax)" \
  "$STATUS $(kz)" "200 [('41', 400, None), ('81', 300, 57), ('83', 57, None)]"
assert_eq "…and names what is declared elsewhere: 430,00 net, 78,75 tax" "$(field "d['ossSales'], d['umsatzsteuer']")" "({'net': 430, 'vat': 78.75}, 57)"
SAVE=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);d.update(taxNumber=None,notes=None,status='draft');print(json.dumps(d))")
AS POST "/api/v1/ustva/filings?companyId=$C" "$SAVE"
assert_eq "the return is saved as the page sends it back, the new field included" "$STATUS $(field "d['outputVat'], d['payableVat']")" "201 ('57', '57')"
PDF=$(mktemp); curl -sS -o "$PDF" -w '' "$API/api/v1/ustva/ustva.pdf?companyId=$C&year=$Y0&month=$M0" -H "x-user-id: $U" -H "x-company-id: $C"
# Tier 643: a heading or footer line written without a position started
# where the last amount's column begins (x = 480 or 380, 90 points wide) and
# broke into "Steuer als L / eistungsem / pfänger". An amount is set flush
# right in its column and never starts at the column's left edge.
assert_eq "the UStVA as a PDF: one page, and no line of text starts at the left edge of an amount column (was: the headings and the footer, 14 lines)" \
  "$(head -c 4 "$PDF") $(python3 - "$PDF" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
pages = len(re.findall(rb'/Type\s*/Page[^s]', d))
xs = set()
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
    try: t = zlib.decompress(m.group(1))
    except Exception: continue
    # "1 0 0 1 x y Tm" places each line of text
    xs.update(round(float(x)) for x in re.findall(rb'1 0 0 1 ([0-9.]+) [0-9.]+ Tm', t))
print(pages, sorted(x for x in xs if x in (380, 480)), 50 in xs)
PY
)" "%PDF 1 [] True"
rm -f "$PDF"
oss "$Y0" "$Q0"
assert_eq "the OSS report has those sales, as before" "$STATUS $(lines) $(field "d['totals']['vatAmount'], d['totals']['vatDue'], d['corrections']")" \
  "200 [('AT', 0.2, 200, 40, 1), ('FR', 0.055, 50, 2.75, 1), ('FR', 0.2, 180, 36, 2)] (78.75, 78.75, [])"

note "=== 2. a credit note in a later quarter ==="
AS POST "/api/v1/invoices/$F3/credit-note?companyId=$C" '{"reason":"Retoure"}'
assert_eq "the French sale over 80 € is credited today" "$STATUS" "201"
ustva "$Y" "$M"
assert_eq "it lowers no German tax (was: Kz 35 −80, Kz 36 −16, 16 € back from the Finanzamt)" "$(kz) $(field "d['ossSales'], d['umsatzsteuer']")" "[] ({'net': -80, 'vat': -16}, 0)"
oss "$Y" "$Q"
assert_eq "it is a correction of the quarter of the sale in this quarter's OSS report (was: in no OSS report)" \
  "$(field "[(c['country'], c['year'], c['quarter'], c['netAmount'], c['vatAmount']) for c in d['corrections']], d['totals']['correctionsVat'], d['totals']['vatDue']")" \
  "([('FR', $Y0, $Q0, -80, -16)], -16, -16)"
oss "$Y0" "$Q0"
assert_eq "…and the earlier quarter stays as it was declared" "$(field "d['totals']['vatAmount'], d['corrections']")" "(78.75, [])"

note "=== 3. credit notes in the quarter of the sale ==="
invoice "$FR" "$TODAY" 100 0.20; G1=$I
invoice "$FR" "$TODAY" 100 0.20; G2=$I
AS POST "/api/v1/invoices/$G1/credit-note?companyId=$C" '{"reason":"Storno"}'
AS POST "/api/v1/invoices/$G2/credit-note?companyId=$C" '{"reason":"Nachlass","amount":60}'
oss "$Y" "$Q"
assert_eq "one sale credited in full, one by 60 €: the line is what is left, 50,00 / 10,00, of two sales (was: 200,00 / 40,00)" \
  "$STATUS $(lines) $(field "d['totals']['vatAmount'], d['totals']['vatDue']")" "200 [('FR', 0.2, 50, 10, 2)] (10, -6)"
CSV=$(curl -sS "$API/api/v1/reports/oss.csv?companyId=$C&year=$Y&quarter=$Q" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "the CSV has the line, the correction and what the return comes to" \
  "$(echo "$CSV" | grep -c '^Frankreich;20,00 %;50,00;10,00;60,00;2$')/$(echo "$CSV" | grep -c "^Frankreich;Q$Q0/$Y0;-80,00;-16,00$")/$(echo "$CSV" | grep -c '^Zu zahlen (Quartal und Berichtigungen);;;-6,00$')" "1/1/1"

note "=== 4. the company's own word: in the OSS scheme or not ==="
# Tier 649. A sale to a consumer in Cyprus at 19 % — Cyprus's rate and
# Germany's. The rate does not say whose tax it is; the company does.
CY=$(customer "Andreas Georgiou" individual CY)
invoice "$CY" "$TODAY" 500 0.19
ustva "$Y" "$M"
assert_eq "not in the OSS scheme (the default): German tax — Kz 81 has it" "$STATUS $(field "[(k['kz'], k['value'], k.get('tax')) for k in d['kennzahlen'] if k['kz']=='81']")" "200 [('81', 500, 95)]"
oss "$Y" "$Q"
assert_eq "…and the OSS report leaves it out and says so" \
  "$(field "d['ossVerfahren'], d['counts']['excludedGermanRate'], [c['country'] for c in d['countries']]")" "(False, 1, ['FR'])"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":"ja"}'
assert_eq "the setting is a flag: a word is refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":true}'
assert_eq "the company registers for the OSS scheme" "$STATUS $(field "d['ossVerfahren']")" "200 True"
ustva "$Y" "$M"
assert_eq "in the OSS scheme: Cyprus's tax — no Kz 81, and named with the other OSS sales" \
  "$(field "[(k['kz'], k['value']) for k in d['kennzahlen'] if k['kz']=='81' and k['value']], d['ossSales']")" "([], {'net': 470, 'vat': 89})"
oss "$Y" "$Q"
assert_eq "…and in the OSS report: Cyprus 19 %, 500,00 / 95,00" \
  "$(field "d['ossVerfahren'], d['counts']['excludedGermanRate'], [(l['vatRate'], l['netAmount'], l['vatAmount']) for c in d['countries'] if c['country']=='CY' for l in c['vatRates']]")" "(True, 0, [(0.19, 500, 95)])"

note "=== 5. Ist-Versteuerung ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
AS POST "/api/v1/invoices/$F1/payments?companyId=$C" '{"amount":120,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
ustva "$Y" "$M"
assert_eq "the French sale paid today is in no Kennzahl of an Ist-Versteuerer either" "$STATUS $(kz) $(field "d['ossSales']['net'] != 0")" "200 [] True"
summary
