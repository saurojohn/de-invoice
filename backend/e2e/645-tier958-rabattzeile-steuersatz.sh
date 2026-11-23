#!/bin/bash
# Tier 958 — a discount entered as a negative line, and the amounts per rate
#
# invoiceTaxBreakdown weighted each line by its absolute value: a line
# "Rabatt" of -200 € at 7 % added 200 € of weight to 7 %. Measured: 1 000 € at
# 19 %, 500 € at 7 % and -200 € at 7 % (stored: 1 300 net, 211 VAT, correct)
# — the PDF stated "USt 19 % auf 764,71 €", the UStVA Kz 81 764,71 / Kz 86
# 535,29 (ELSTER computes 182,61 € from them, 211 € are owed), DATEV booked
# 932,45 on 8400 and 578,55 on 8300, and a credit note of 755,50 € was split
# −391,78 / −270,36 instead of −500 / −150. § 14 Abs. 4 Nr. 8 UStG: the
# amount and the tax per rate are 1 000 / 190 and 300 / 21.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-645-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier958-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-12\",\"deliveryDate\":\"2026-10-12\",\"items\":[{\"description\":\"Werkzeug\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19},{\"description\":\"Buch\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.07},{\"description\":\"Rabatt auf Buch\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":-200,\"vatRate\":0.07}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "stored: 1 300 net, 211 VAT" "$(P "(float(d['subtotal']), float(d['totalVat']))")" "(1300.0, 211.0)"

AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=10"
assert_eq "UStVA October: Kz 81 1 000, Kz 86 300 (was 764,71 / 535,29)" \
  "$(P "({k['kz']: float(k['value']) for k in d['kennzahlen'] if k.get('value')}.get('81'), {k['kz']: float(k['value']) for k in d['kennzahlen'] if k.get('value')}.get('86'))")" "(1000.0, 300.0)"
AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=2026-10-01&endDate=2026-10-31"
assert_eq "DATEV: 1 190 on 8400, 321 on 8300 (was 932,45 / 578,55)" \
  "$(P "sorted((r.get('gegenkonto'), float(str(r.get('betrag')).replace(',', '.'))) for r in d['firstRows'] if r.get('gegenkonto') in ('8400', '8300'))")" "[('8300', 321.0), ('8400', 1190.0)]"
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":755.50,"reason":"Rückgabe zur Hälfte"}'
CN=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$CN?companyId=$C"
assert_eq "a credit note of half the gross: 500 at 19 %, 150 at 7 % (was 391,78 / 270,36)" \
  "$(P "sorted((float(i['vatRate']), round(abs(float(i['quantity']) * float(i['unitPrice'])), 2)) for i in d['items'])")" "[(0.07, 150.0), (0.19, 500.0)]"

summary
