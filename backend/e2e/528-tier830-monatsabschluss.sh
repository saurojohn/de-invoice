#!/bin/bash
# Tier 830 — the month-end drill (October 2026 of a GmbH on the production
# images: domestic 19 % / 7 %, an igL to Austria, a § 3a service to France,
# an export to Switzerland, a storno, a cash sale; goods, rent, a book,
# office supplies, an igE from Italy, Google Ads from Ireland, a laptop on
# 0400; the bank matched). UStVA, ZM, BWA revenue, GuV, DATEV's balance and
# the bank agreed with the figures worked out by hand — two things did not:
#
#  1. The computed AfA of a period was the year's AfA × its months / 12
#     (BWA since Tier 86, shared since Tier 824): the laptop of 1 100 € over
#     36 months, bought 24.10., stood in the BWA's October with 7,64 € (the
#     year's 91,67 € / 12) instead of 30,56 €, and in every month before its
#     purchase too. Now each asset's AfA in the months it is depreciated
#     (booked-afa.ts computedAfaInWindow); the BWA's prior-year column takes
#     the computed AfA as well (it took only the booked).
#  2. DATEV: every bill without an account of its own went to 4900 — goods,
#     rent, the book, Google Ads, the igE alike. The Sachkonto comes from the
#     bill's category and text (datev-sachkonto-inference.ts); its SKR03
#     numbers corrected (Porto / Telefon were 4970, Versicherungen 4380,
#     Werbung 4760) and goods, material, Fremdleistungen, Bewirtung, … added.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-528-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier830-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

note "=== 1. the AfA of an asset bought in October ==="
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"Laptop","anschaffungsDatum":"2025-10-24","anschaffungsKosten":1100,"nutzungsdauerMonate":36,"bilanzKonto":"0400"}'
assert_eq "fixture: a laptop of 1 100 € over 36 months, bought 24.10.2025" "$STATUS" "201"
bwa() { AS GET "/api/v1/reports/bwa?companyId=$C&year=$1&month=$2"; py "l={x['bucket']:x for x in d['lines']}['3100'];print('%.2f/%.2f/%.2f' % (l['monat'], l['ytd'], l['vorjahresYtd']))"; }
assert_eq "BWA September 2025: no AfA yet (was 7,64 a month)" "$(bwa 2025 9)" "0.00/0.00/0.00"
assert_eq "BWA October 2025: one month's AfA, 30,56 (was 7,64)" "$(bwa 2025 10)" "30.56/30.56/0.00"
assert_eq "BWA December 2025: the year's three months, 91,67" "$(bwa 2025 12)" "30.56/91.67/0.00"
assert_eq "BWA October 2026: the prior year's January–October beside it, 30,56 (was 0: only booked AfA counted)" "$(bwa 2026 10)" "30.56/305.56/30.56"
AS GET "/api/v1/reports/pnl?companyId=$C&year=2025"
assert_eq "the monthly P&L: September 0, October −30,56, the year −91,67" \
  "$(py "m=d['months'];print('%.2f %.2f %.2f' % (m[8]['operatingResult'], m[9]['operatingResult'], d['ytd']['operatingResult']))")" "0.00 -30.56 -91.67"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2025"
assert_eq "the GuV of 2025: the same 91,67" "$(py "
pos={}
def w(o):
  if isinstance(o,dict):
    if 'position' in o: pos[str(o['position'])]=o.get('amount')
    for v in o.values(): w(v)
  elif isinstance(o,list):
    for v in o: w(v)
w(d);print('%.2f' % (pos.get('7a') or 0))")" "91.67"

note "=== 2. DATEV: the bill's Sachkonto ==="
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Conceria Toscana","vatId":"IT01234567890","address":{"street":"Via 7","postalCode":"56029","city":"Santa Croce","country":"IT"}}'; L2=$(py 'print(d["id"])')
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Google Ireland","vatId":"IE6388047V","address":{"street":"Barrow St","postalCode":"D04","city":"Dublin","country":"IE"}}'; L3=$(py 'print(d["id"])')
exp() { AS POST "/api/v1/expenses?companyId=$C" "$1"; [[ "$STATUS" == 2* ]] || fail "expense → $STATUS $BODY"; }
exp '{"description":"Rindleder","invoiceNumber":"W-1","invoiceDate":"2026-10-03","netAmount":1200,"vatRate":0.19,"vatAmount":228,"grossAmount":1428,"category":"Wareneinkauf"}'
exp '{"description":"Werkstatt Oktober","invoiceNumber":"M-1","invoiceDate":"2026-10-01","netAmount":800,"vatRate":0.19,"vatAmount":152,"grossAmount":952,"category":"Miete"}'
exp '{"description":"Druckerpapier","invoiceNumber":"B-1","invoiceDate":"2026-10-06","netAmount":42.02,"vatRate":0.19,"vatAmount":7.98,"grossAmount":50,"category":"Büromaterial"}'
exp '{"description":"Fachbuch Gerbverfahren","invoiceNumber":"F-1","invoiceDate":"2026-10-09","netAmount":37.38,"vatRate":0.07,"vatAmount":2.62,"grossAmount":40,"category":"Fachliteratur"}'
exp "{\"supplierId\":\"$L2\",\"description\":\"Vacchetta-Leder\",\"invoiceNumber\":\"CT-1\",\"invoiceDate\":\"2026-10-13\",\"netAmount\":2000,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":2000,\"category\":\"Wareneinkauf\",\"isIntraEU\":true}"
exp "{\"supplierId\":\"$L3\",\"description\":\"Google Ads Oktober\",\"invoiceNumber\":\"GA-1\",\"invoiceDate\":\"2026-10-20\",\"netAmount\":150,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":150,\"category\":\"Werbung\",\"isReverseCharge\":true}"
exp '{"description":"Schneidwerkzeug","invoiceNumber":"K-1","invoiceDate":"2026-10-21","netAmount":84.03,"vatRate":0.19,"vatAmount":15.97,"grossAmount":100,"category":"Diverses","accountNumber":"4985"}'
exp '{"description":"Xyzzy","invoiceNumber":"X-1","invoiceDate":"2026-10-22","netAmount":10,"vatRate":0.19,"vatAmount":1.9,"grossAmount":11.9}'
AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=2026-10-01&endDate=2026-10-31"
acct() { py "a={x['konto']:x for x in d['byAccount']};x=a.get('$1');print('%.2f' % (x['soll']-x['haben']) if x else 'none')"; }
assert_eq "goods 3200 (Wareneingang, with its key — not the automatic 3400): 1 428 + the igE's 2 000" "$(acct 3200)" "3428.00"
assert_eq "rent 4210 / office supplies 4930 / the book 4940 / Google Ads 4600" "$(acct 4210) $(acct 4930) $(acct 4940) $(acct 4600)" "952.00 50.00 40.00 150.00"
assert_eq "an account of its own wins (4985), and a bill nothing matches stays on 4900" "$(acct 4985) $(acct 4900)" "100.00 11.90"
assert_eq "Soll = Haben, and no error" "$(py "print('%.2f' % d['balanceDelta'], [i['message'][:50] for i in d['issues'] if i['severity']=='error'])")" "0.00 []"
AS GET "/api/v1/reports/datev-export?companyId=$C&startDate=2026-10-01&endDate=2026-10-31"
# (key 94 for a service from the EU is Tier 423's; whether DATEV wants 46 or the
# automatic account 3123 for § 13b Abs. 1 is open — HANDOFF, Tier 830)
assert_eq "in the Buchungsstapel the igE keeps its key 19 and the Ads their § 13b key on the new accounts" \
  "$(echo "$BODY" | python3 -c "
import sys
rows=[l.split(';') for l in sys.stdin.read().splitlines()[2:] if l]
def f(beleg):
  for r in rows:
    if r[10].strip('\"')==beleg: return r[7].strip('\"')+'|'+r[8].strip('\"')
print(f('CT-1'), f('GA-1'))")" "3200|19 4600|94"

note "=== 3. the SKR03 names ==="
N=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
import { inferExpenseAccount as f } from './src/modules/reports/datev-sachkonto-inference'
console.log(['DHL Paket','Telekom Rechnung','Haftpflichtversicherung','Werbung Messe','Hotel Berlin','Bankgebühren Oktober','Bewirtung Kunde'].map((t) => f(t).accountNumber).join(' '))
" 2>&1 | tail -1)
assert_eq "Porto 4910, Telefon 4920, Versicherungen 4360, Werbekosten 4600, Reisekosten 4660, Geldverkehr 4970, Bewirtung 4650 (were 4970 / 4970 / 4380 / 4760 / 4760 / — / 4760)" \
  "$N" "4910 4920 4360 4600 4660 4970 4650"
summary
