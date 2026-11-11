#!/bin/bash
# Tier 832 — a review of Tiers 822–831. Three things were wrong:
#
#  1. The Sachkonto inference (Tier 830) matched short keywords inside
#     longer words: "gas" in "Gastronomie" / "Gasthaus" (→ 4240 Gas, Strom),
#     "messe" in "Messer" (→ 4600), "kabel" in "Kabelbinder" (→ 4920),
#     "fond" in "Fondue", "sea" in "Seat"; and a tie went to the first rule,
#     not the longer keyword. Short keywords now match whole words only, a
#     tie goes to the longer keyword; Werbematerial / Messestand → 4600,
#     Warenwirtschaft → 4964, Verpackung → 4710 (new).
#  2. A company that set its own default expense account in the DATEV
#     settings got the inference instead: its default is now used as before.
#  3. AfA: booked or computed was decided for the whole year — one asset
#     booked made every other asset's AfA vanish from GuV / BWA, and EÜR,
#     Anlage S and Anlage G took the booked AfA only (none when nothing was
#     booked). Now per asset: booked where the asset has bookings, computed
#     otherwise (booked-afa.ts afaOfYear), in GuV, BWA, P&L, EÜR, Anlage S/G.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-529-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier832-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
guv7a() { py "
pos={}
def w(o):
  if isinstance(o,dict):
    if 'position' in o: pos[str(o['position'])]=o.get('amount')
    for v in o.values(): w(v)
  elif isinstance(o,list):
    for v in o: w(v)
w(d);print('%.2f' % (pos.get('7a') or 0))"; }

note "=== 1. the inference: whole words, the longer keyword ==="
N=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
import { inferExpenseAccount as f } from './src/modules/reports/datev-sachkonto-inference'
console.log(['Gastronomie Bedarf','Gasthaus Krone','Messer','Kabelbinder','Fondue-Set','Seat Leon Service','Werbematerial','Messestand','Warenwirtschaft Lizenz','Verpackungsmaterial'].map((t) => { const r = f(t); return r.confidence > 0 ? r.accountNumber : '-' }).join(' '))
console.log(['Gas Stadtwerke','Telekom Rechnung','DHL Paket','Bewirtung Kunde','Hotel Berlin'].map((t) => f(t).accountNumber).join(' '))
" 2>&1 | tail -2)
assert_eq "no match inside a longer word (Gastronomie is Bewirtung, Gasthaus nothing — both were 4240 Gas); Werbematerial / Messestand 4600, Warenwirtschaft 4964, Verpackung 4710" \
  "$(echo "$N" | head -1)" "4650 - - - - - 4600 4600 4964 4710"
assert_eq "…and the plain cases unchanged (Gas 4240, Telefon 4920, Porto 4910, Bewirtung 4650, Reisekosten 4660)" \
  "$(echo "$N" | tail -1)" "4240 4920 4910 4650 4660"

note "=== 2. a company's own default expense account wins over the inference ==="
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Druckerpapier","invoiceNumber":"B-529","invoiceDate":"2026-10-06","netAmount":42.02,"vatRate":0.19,"vatAmount":7.98,"grossAmount":50,"category":"Büromaterial"}'
assert_status 201 "fixture: an office-supplies bill"
acct() { AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=2026-10-01&endDate=2026-10-31"; py "a={x['konto']:x for x in d['byAccount']};print(' '.join('%s=%.2f' % (k, a[k]['soll']-a[k]['haben']) for k in ('4930','4980','4900') if k in a))"; }
assert_eq "SKR03's default: the bill goes to 4930 (Bürobedarf)" "$(acct)" "4930=50.00"
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"accounts":{"expenseDefault":"4980"}}'
assert_status 200 "the company sets 4980 as its default"
assert_eq "…then its 4980, as before Tier 830 (was 4930)" "$(acct)" "4980=50.00"

note "=== 3. AfA per asset: one booked, one not ==="
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Nähmaschine","anschaffungsDatum":"2025-01-01","anschaffungsKosten":12000,"nutzungsdauerMonate":60,"bilanzKonto":"0400"}'
assert_status 201 "fixture: a machine of 12 000 € over 60 months, 01.01.2025"
AS POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=2025"
[[ "$STATUS" == 2* ]] && pass "its AfA 2025 booked month by month" || fail "book-afa-monthly → $STATUS $BODY"
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"Laptop","anschaffungsDatum":"2025-10-24","anschaffungsKosten":1100,"nutzungsdauerMonate":36,"bilanzKonto":"0400"}'
assert_status 201 "fixture: a laptop of 1 100 € over 36 months, 24.10.2025, not booked"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2025"
assert_eq "GuV 2025 7a: 2 400 booked + 91,67 computed (was 2 400)" "$(guv7a)" "2491.67"
AS GET "/api/v1/reports/bwa?companyId=$C&year=2025&month=12"
assert_eq "BWA December 2025: 200 + 30,56 in the month, 2 491,67 in the year (was 200 / 2 400)" \
  "$(py "l={x['bucket']:x for x in d['lines']}['3100'];print('%.2f/%.2f' % (l['monat'], l['ytd']))")" "230.56/2491.67"
AS GET "/api/v1/reports/pnl?companyId=$C&year=2025"
assert_eq "the P&L of 2025: −2 491,67" "$(py "print('%.2f' % d['ytd']['operatingResult'])")" "-2491.67"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "EÜR 2025 AfA (4600): 2 491,67 (was 2 400)" \
  "$(py "print(' '.join('%.2f' % l['amount'] for l in d.get('ausgaben',[]) if l.get('kennziffer')=='4600'))")" "2491.67"

note "=== 4. nothing booked: EÜR, Anlage S and G take the computed AfA ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026 AfA: 2 400 + 366,67 computed (was 0 — only booked AfA counted)" \
  "$(py "print(' '.join('%.2f' % l['amount'] for l in d.get('ausgaben',[]) if l.get('kennziffer')=='4600'))")" "2766.67"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "Anlage S 2026: the same AfA, its source 'computed' (was 0 / nicht_gebucht)" \
  "$(py "
def find(o):
  if isinstance(o,dict):
    for k,v in o.items():
      if k=='afaSource': return v
      r=find(v)
      if r: return r
  elif isinstance(o,list):
    for v in o:
      r=find(v)
      if r: return r
print(find(d), '2766.67' in json.dumps(d) or '2766.67' in json.dumps(d).replace('2766.6666','2766.67'))")" "computed True"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2026"
assert_eq "Anlage G 2026: the AfA in its costs" "$(python3 -c "import sys;print('2766.67' in sys.argv[1])" "$BODY")" "True"
summary
