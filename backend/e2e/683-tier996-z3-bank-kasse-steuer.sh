#!/bin/bash
# Tier 996 — the Z3 data set carries the bank statements, the cash closes and
# the tax payments
#
# The Datenüberlassung held the bookings, invoices, expenses and the cash book
# — not the imported bank transactions, the signed daily cash closes (count,
# difference, its reason) nor the VAT payments to the Finanzamt. All three are
# records the auditor's data access covers (§ 147 Abs. 6 AO, GoBD Rz. 158 ff.;
# the Kassensturz: § 146 Abs. 1 AO).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-683-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
D=$(TZ=Europe/Berlin date -v-3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days ago' +%F)
Y=${D:0:4}
S6=$(python3 -c "import sys;d=sys.argv[1];print(d[2:4]+d[5:7]+d[8:10])" "$D")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier996-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
{
  printf ':20:ST1\n:25:DE89370400440532013000\n:28C:1/1\n:60F:C%sEUR0,00\n' "$S6"
  printf ':61:%s%sC250,00NTRFNONREF\n:86:166?00GUTSCHRIFT?20Zahlung %s?32Kunde A\n' "$S6" "${S6:2:4}" "$TAG"
  printf ':62F:C%sEUR250,00\n-\n' "$S6"
} > "$W/st.mt940"
curl -sS -o /dev/null -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$W/st.mt940;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":100}"
AS POST "/api/v1/cashbook/close-day?companyId=$C" "{\"date\":\"$D\",\"physicalCount\":95,\"differenzNote\":\"Wechselgeld $TAG\"}"
assert_eq "fixture: a cash day closed with a difference of −5 €" "$STATUS" "201"
AS POST "/api/v1/ustva/payments?companyId=$C" "{\"kind\":\"sondervorauszahlung\",\"year\":$Y,\"paidAt\":\"$D\",\"amount\":300,\"note\":\"SVZ $TAG\"}"
assert_eq "fixture: a VAT payment" "${STATUS:0:2}" "20"

curl -sS -o "$W/g.zip" "$API/api/v1/gobd-export?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
mkdir "$W/g" && (cd "$W/g" && unzip -q ../g.zip)
table() { # name column… → "count value…" of the rows naming the tag
  python3 - "$W/g/datenueberlassung" "$TAG" "$@" <<'PY'
import sys, csv, os, xml.etree.ElementTree as ET
d, tag, name, cols = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
idx = open(d + '/index.xml', encoding='utf-8').read()
idx = idx[idx.index('<DataSet>'):]
t = [t for t in ET.fromstring(idx).iter('Table') if t.findtext('Name') == name]
if not t: print('no-table'); sys.exit()
names = [e.findtext('Name') for e in t[0].find('VariableLength') if e.tag in ('VariablePrimaryKey', 'VariableColumn')]
rows = [dict(zip(names, r)) for r in csv.reader(open(os.path.join(d, t[0].findtext('URL')), encoding='utf-8', newline=''), delimiter=';', quotechar='"')]
hit = [r for r in rows if any(tag in v for v in r.values())]
print(' '.join([str(len(hit))] + [hit[0].get(c, '<no ' + c + '>') if hit else '-' for c in cols]))
PY
}
assert_eq "Bankumsaetze: the receipt of 250 € (was: no table)" "$(table Bankumsaetze Betrag)" "1 250,00"
assert_eq "Kassenabschluesse: the count and the difference (was: no table)" "$(table Kassenabschluesse Gezaehlt Differenz)" "1 95,00 -5,00"
assert_eq "Steuerzahlungen: the payment of 300 € (was: no table)" "$(table Steuerzahlungen Art Betrag)" "1 sondervorauszahlung 300,00"
summary
