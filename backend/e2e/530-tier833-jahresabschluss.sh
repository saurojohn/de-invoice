#!/bin/bash
# Tier 833 — the year-end drill (2025 of a GmbH founded 02.01.2025 on the
# production images: four quarterly UStVA filed and paid, ZM, the annual VAT
# return, GuV, KSt 1, GewSt, Bilanz, DATEV, E-Bilanz, Anhang, the books closed).
# Two figures did not agree with the ones worked out by hand:
#
#  1. KSt 1 took 15 % of the zvE to the cent (3 988,89 → 598,33 €) and the Soli
#     of that (32,91). The KSt is rounded to full euros in the taxpayer's
#     favour (§ 31 Abs. 1 S. 2 KStG): 598 €, and the Soli is 5,5 % of the KSt
#     as set, fractions of a cent dropped (§ 3 Abs. 1 Nr. 1, § 4 S. 3 SolZG):
#     32,89 €. The GuV's taxes, the Jahresüberschuss and the
#     Steuerrückstellung follow.
#  2. An asset whose `bilanzKonto` was not one of the Bilanz positions 0100–0500
#     — the SKR03 account 0210 Maschinen, set through the API — was off the
#     Bilanz: its Buchwert went to a pool no line reads, and the Saldoposten
#     took it (equity 20 100 instead of the Stammeinlage 25 000). It now counts
#     under the position of the asset's type.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-530-$(date +%s%N | cut -c1-13)"
Y=2025
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier833-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
assert_status 200 "fixture: a GmbH"

note "=== 1. KSt to the full euro, the Soli of it ==="
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
CUST=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CUST'","issueDate":"'$Y'-03-01","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":3988.89,"vatRate":0.19}]}'
INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_status 200 "fixture: 3 988,89 € net revenue in $Y"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"
assert_eq "zvE 3 988,89; KSt 598 (was 598,33); Soli 32,89 (was 32,91)" \
  "$(py "t=d['totals'];print('%.2f %.2f %.2f' % (t['zve'], t['kst'], t['soli']))")" "3988.89 598.00 32.89"
assert_eq "GewSt: 3 900 × 3,5 % × 400 % = 546 (unchanged)" "$(py "print('%.2f' % d['totals']['gewst'])")" "546.00"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "the GuV's Jahresüberschuss after 598 + 32,89 + 546 (was 3 988,89 − 1 177,24)" \
  "$(py "print('%.2f' % d['totals']['jahresueberschuss'])")" "2812.00"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "the Bilanz: Steuerrückstellungen 1 176,89" \
  "$(py "print(['%.2f' % l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='3100'][0])")" "1176.89"

note "=== 2. an asset on an SKR03 account stays on the Bilanz ==="
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Nähmaschine","anschaffungsDatum":"2025-02-01","anschaffungsKosten":6000,"nutzungsdauerMonate":60,"bilanzKonto":"0210"}'
assert_status 201 "fixture: a machine of 6 000 € on 0210, from 01.02.2025"
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"Laptop","anschaffungsDatum":"2025-11-15","anschaffungsKosten":1100,"nutzungsdauerMonate":36,"bilanzKonto":"0400"}'
assert_status 201 "fixture: a laptop on 0400"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "0300 Technische Anlagen und Maschinen 4 900 (was not shown); 0400 the laptop 1 038,89" \
  "$(py "a={l['position']:l['amount'] for s in d['aktiva'] for l in s['lines']};print('%.2f %.2f' % (a['0300'] or 0, a['0400'] or 0))")" "4900.00 1038.89"
assert_eq "the Anlagevermögen's subtotal 5 938,89 (was 1 038,89)" \
  "$(py "print('%.2f' % [s['subtotal'] for s in d['aktiva'] if s['title'].startswith('A.')][0])")" "5938.89"
assert_eq "Aktiva = Passiva" "$(py "print(d['balanceCheck']['balanced'])")" "True"
summary
