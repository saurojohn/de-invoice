#!/bin/bash
# Tier 987 — the Z3 table „Rechnungen“ lets the auditor reproduce the tax base
#
# Measured: an invoice with 10 % discount (100 € at 19 % + 50 € at 7 %) —
# rechnungen.csv said Netto 150,00 / USt 20,25 / Brutto 155,25: 150 + 20,25 ≠
# 155,25, the 15,00 discount and the Entgelt of 135,00 (§ 10 UStG) in no
# column; a credit note's Kunde was empty; no date of supply (§ 14 Abs. 4
# Nr. 6 UStG), no reference of a credit note to its invoice.
# § 147 Abs. 6 AO, GoBD Rz. 158 ff.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-674-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
D=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)
Y=${D:0:4}

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier987-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde Rabatt GmbH","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"discountPercent\":10,\"items\":[{\"description\":\"A\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19},{\"description\":\"B\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.07}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
NI=$(json_field "$BODY" invoiceNumber)
assert_eq "fixture: issued, 155,25 €" "$STATUS/$(json_field "$BODY" total)" "200/155.25"
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":50,"reason":"Gutschrift"}'
CN=$(json_field "$BODY" invoiceNumber)
AS GET "/api/v1/invoices/$(json_field "$BODY" id)?companyId=$C"
[[ "$(json_field "$BODY" status)" == "draft" ]] && { AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'; CN=$(json_field "$BODY" invoiceNumber); }

curl -sS -o "$W/g.zip" "$API/api/v1/gobd-export?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
mkdir "$W/g" && (cd "$W/g" && unzip -q ../g.zip)
row() { # invoiceNumber column…
  python3 - "$W/g/datenueberlassung" "$@" <<'PY'
import sys, csv, xml.etree.ElementTree as ET
d, num, cols = sys.argv[1], sys.argv[2], sys.argv[3:]
idx = open(d + '/index.xml', encoding='utf-8').read()
idx = idx[idx.index('<DataSet>'):]
t = [t for t in ET.fromstring(idx).iter('Table') if t.findtext('Name') == 'Rechnungen'][0]
names = [e.findtext('Name') for e in t.find('VariableLength') if e.tag in ('VariablePrimaryKey', 'VariableColumn')]
rows = list(csv.reader(open(d + '/rechnungen.csv', encoding='utf-8', newline=''), delimiter=';', quotechar='"'))
r = [x for x in rows if x and x[0] == num]
if not r: print('no row'); sys.exit()
rec = dict(zip(names, r[0]))
print(' '.join(rec.get(c, '<no ' + c + '>') for c in cols))
PY
}
assert_eq "the invoice: Netto 150, Rabatt 15, Entgelt 135 + USt 20,25 = Brutto 155,25 (was: no Rabatt, no Entgelt)" \
  "$(row "$NI" Netto Rabatt Netto_nach_Rabatt Umsatzsteuer Brutto)" "150,00 15,00 135,00 20,25 155,25"
DDE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1]).strftime('%d.%m.%Y'))" "$D")
assert_eq "…and its date of supply" "$(row "$NI" Leistungsdatum)" "$DDE"
assert_eq "the credit note: its customer and the invoice it corrects (was: Kunde empty)" "$(row "$CN" Kunde Bezugsrechnung)" "Kunde Rabatt GmbH $NI"

summary
