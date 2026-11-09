#!/bin/bash
# Tier 817 — the review of Tiers 814-816
#
#  1. The dashboard's „Gewinn YTD" was net revenue less every bill received:
#     a laptop bought on 0400 (an asset — its AfA is the cost, Tier 815)
#     lowered it by its full price; the manual vouchers (Tier 816) were not
#     in it. It is net revenue less the costs as the GuV counts them now; the
#     monthly P&L (/reports/pnl) the same.
#  2. A manual voucher on 2150 (Aufwendungen aus Kursdifferenzen) or 2660
#     (Erträge aus Kursdifferenzen) was sorted as interest (GuV 13 / 11, BWA
#     4200 / 4100, the GewSt's § 8 Nr. 1a add-back): SKR03 has interest on
#     2100-2149 and 2650-2659 / 2670-2689; exchange differences are other
#     operating costs and income (GuV 8 / 4).
#  3. The BWA's „Vormonat" column was 0 on every line but the revenue, and in
#     January the revenue's Vormonat (December) had no invoices in it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-517-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F) # the business day (Tier 821b)
YEAR=${TODAY:0:4}
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier817-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
ok() { [[ "$STATUS" == 2* ]] && pass "fixture: $1" || fail "fixture: $1 → $STATUS $(echo "$BODY" | head -c 300)"; }

AS POST "/api/v1/accounting/accounts/seed?companyId=$C"; ok "the chart of accounts"
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"2150","name":"Aufwendungen aus Kursdifferenzen","type":"expense"}'; ok "account 2150"
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"2660","name":"Erträge aus Kursdifferenzen","type":"revenue"}'; ok "account 2660"
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"2650","name":"Sonstige Zinsen und ähnliche Erträge","type":"revenue"}'; ok "account 2650"
AS GET "/api/v1/accounting/accounts?companyId=$C"
ACC="$BODY"
acct() { echo "$ACC" | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin) if a['accountNumber']=='$1'][0])"; }
BANK=$(acct 1200)
manual() { # date debit-account credit-account amount text
  AS POST "/api/v1/accounting/vouchers?companyId=$C" "{\"companyId\":\"$C\",\"date\":\"$1\",\"description\":\"$5\",\"referenceType\":\"Manual\",\"lines\":[{\"accountId\":\"$(acct $2)\",\"debit\":$4,\"credit\":0},{\"accountId\":\"$(acct $3)\",\"debit\":0,\"credit\":$4}]}"
  ok "manual voucher $5"
}

# --- 1 + 2: this year, today ---------------------------------------------------
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Beratung","quantity":1,"unit":"Std","unitPrice":1000,"vatRate":0.19}]}'
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; ok "an invoice of 1 000 net"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Laptop","invoiceNumber":"L-1","invoiceDate":"'$TODAY'","netAmount":1500,"vatRate":0.19,"vatAmount":285,"grossAmount":1785,"category":"Betriebsausstattung","accountNumber":"0400"}'; ok "a laptop of 1 500 net on 0400"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Porto","invoiceNumber":"P-1","invoiceDate":"'$TODAY'","netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238,"category":"Porto"}'; ok "postage of 200 net"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"KSt Q1","invoiceNumber":"K-1","invoiceDate":"'$TODAY'","netAmount":100,"vatRate":0,"vatAmount":0,"grossAmount":100,"category":"Körperschaftsteuer"}'; ok "a KSt prepayment of 100"
manual "$TODAY" 1200 2650 50 "Habenzinsen"
manual "$TODAY" 2150 1200 30 "Kursverlust"
manual "$TODAY" 1200 2660 20 "Kursgewinn"

AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "the bills received are still all in „Ausgaben\" (1 500 + 200 + 100)" "$(py 'print("%.2f" % d["ytd"]["expenses"])')" "1800.00"
assert_eq "„Gewinn YTD\" is 1 000 − 200 + 50 − 30 + 20 = 840: the laptop is an asset, the KSt a tax on income (was −800)" \
  "$(py 'print("%.2f" % d["ytd"]["net"])')" "840.00"
AS GET "/api/v1/reports/pnl?companyId=$C&year=$YEAR"
assert_eq "the monthly P&L says the same" "$(py 'print("%.2f" % d["ytd"]["operatingResult"])')" "840.00"

AS GET "/api/v1/accounting/guv?companyId=$C&year=$YEAR"
GUV() { py "
pos={}
def walk(o):
  if isinstance(o,dict):
    if 'position' in o: pos[str(o['position'])]=o.get('amount')
    for v in o.values(): walk(v)
  elif isinstance(o,list):
    for v in o: walk(v)
walk(d)
print(' '.join('%s=%.2f' % (k, pos.get(k) or 0) for k in $1))"; }
assert_eq "GuV: the exchange gain is other income (4), the loss an other cost (8), only the Habenzinsen interest (11), no interest cost (13)" \
  "$(GUV "['4','8','11','13']")" "4=20.00 8=230.00 11=50.00 13=0.00"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=$((10#${TODAY:5:2}))"
BWA() { py "l={x['bucket']:x for x in d['lines']};print(' '.join('%s=%.2f' % (b, l[b]['$1']) for b in $2))"; }
assert_eq "BWA: the same — 1300 other income, 4100 Habenzinsen, nothing in 4200" "$(BWA ytd "['1300','4100','4200']")" "1300=20.00 4100=50.00 4200=0.00"

# --- 3: the Vormonat column, in January of next year's BWA view ------------------
PY=$((YEAR - 1))
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$PY'-12-05","items":[{"description":"Beratung Dezember","quantity":1,"unit":"Std","unitPrice":700,"vatRate":0.19}]}'
I2=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I2/status?companyId=$C" '{"status":"sent"}'; ok "an invoice of 700 net on 05.12. of the year before"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Miete Dezember","invoiceNumber":"M-12","invoiceDate":"'$PY'-12-10","netAmount":400,"vatRate":0.19,"vatAmount":76,"grossAmount":476,"category":"Miete"}'; ok "rent of 400 net in December"
manual "$PY-12-20" 2150 1200 15 "Kursverlust Dezember"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=1"
assert_eq "January's Vormonat is December: revenue 700, rent 400 (3200), the exchange loss 15 (3600)" \
  "$(BWA vormonat "['1000','3200','3600']")" "1000=700.00 3200=400.00 3600=15.00"
assert_eq "…and no December row in January's own columns or the year's counts" \
  "$(py "l={x['bucket']:x for x in d['lines']};print('%.2f %.2f' % (l['1000']['monat'], l['3200']['ytd']), d['counts']['invoices'], d['counts']['expenses'])")" \
  "$([[ ${TODAY:5:2} == 01 ]] && echo "1000.00 0.00 1 2" || echo "0.00 0.00 0 0")"
AS GET "/api/v1/reports/bwa?companyId=$C&year=$PY&month=12"
assert_eq "December's own month shows them, so the column is the month before's" \
  "$(BWA monat "['1000','3200','3600']")" "1000=700.00 3200=400.00 3600=15.00"
summary
