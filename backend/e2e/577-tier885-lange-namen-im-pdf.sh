#!/bin/bash
# Tier 885 — long names on the invoice and the Mahnung
#
# Found by rendering a 35-line invoice with ordinary German names:
#   - the letterhead drew „Müller & Söhne Gebäudetechnik und
#     Sanitärinstallationen GmbH“ at 18 pt on one line — it ran off the page
#     („… GmbI“);
#   - the recipient „Bundesanstalt für Immobilienaufgaben – Direktion Mitte,
#     Sparte Facility Management Liegenschaft Kaserne Nord“ was one line: it
#     ran under the „RECHNUNG“ title and lost „Nord“. Both full names are
#     § 14 Abs. 4 Nr. 1 UStG items.
#   - the Mahnung was addressed to the contact person alone, without the
#     company that owes the money.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-577-$(date +%s%N | cut -c1-13)"
LONG_CO="Müller & Söhne Gebäudetechnik und Sanitärinstallationen GmbH"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier885-e2e\",\"companyName\":\"$LONG_CO\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
q "update \"Company\" set name='$LONG_CO', \"logoPath\"=null where id='$C'" >/dev/null
DIR=$(mktemp -d)
get_pdf() { curl -sS "$API$1" -H "x-user-id: $U" -H "x-company-id: $C" -o "$2"; }

AS POST "/api/v1/customers?companyId=$C" '{"name":"Bundesanstalt für Immobilienaufgaben – Direktion Mitte, Sparte Facility Management Liegenschaft Kaserne Nord","type":"business","address":{"street":"Ellerstraße 56","city":"Bonn","postalCode":"53119","country":"DE"}}'
K=$(field id)
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
INV=$(field id)
assert_eq "fixture: a draft for the long-named customer" "$STATUS" "201"
get_pdf "/api/v1/invoices/$INV/pdf?companyId=$C" "$DIR/inv.pdf"
POS=$(pdf_text "$DIR/inv.pdf" --pos)

note "=== 1. the letterhead ==="
assert_eq "the company's name is set smaller than 18 pt so it fits (was: 18 pt, cut at the page edge)" \
  "$(python3 -c "
import json,sys
runs=json.loads(sys.argv[1])[0]
r=[x for x in runs if x['s'].startswith('Müller & Söhne Gebäudetechnik') and x['y']<30]
print('fits' if r and r[0]['size']<18 and r[0]['size']>=10 else r)" "$POS")" "fits"

note "=== 2. the recipient wraps inside the window ==="
assert_eq "the full name, on lines starting at 25 mm (was: one line, „Nord“ lost under the title)" \
  "$(python3 -c "
import json,sys
runs=json.loads(sys.argv[1])[0]
lines=[x for x in runs if abs(x['x']-25.0)<0.6 and 55<x['y']<110 and x['size']>=10]
text=' '.join(x['s'] for x in lines)
print(len([x for x in lines if 'Bundesanstalt' in x['s'] or 'Direktion' in x['s'] or 'Kaserne' in x['s']])>=2, 'Liegenschaft Kaserne Nord' in text)" "$POS")" "True True"

note "=== 3. the Mahnung is addressed to the company ==="
AS POST "/api/v1/customers?companyId=$C" '{"name":"Hafenlogistik Nord GmbH","type":"business","contact":{"name":"Hans Schmidt","email":""},"address":{"street":"Hafenstr. 3","city":"Bremen","postalCode":"28195","country":"DE"}}'
K2=$(field id)
OLD=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=60)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K2\",\"issueDate\":\"$OLD\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Lagerung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.19}]}"
INV2=$(field id)
AS PUT "/api/v1/invoices/$INV2/status?companyId=$C" '{"status":"sent"}'
MB=$(printf '{"companyId":"%s","invoiceId":"%s","level":"first","channel":"post"}' "$C" "$INV2")
AS POST "/api/v1/reminders/send" "$MB"
M=$(field mahnungId)
get_pdf "/api/v1/reminders/mahnungen/$M/pdf?companyId=$C" "$DIR/m.pdf"
LINES=$(pdf_text "$DIR/m.pdf" --lines)
assert_eq "the company first, the contact person below it (was: „Hans Schmidt“ alone)" \
  "$(python3 -c "
import sys
l=[x.strip() for x in sys.argv[1].splitlines()]
c=l.index('Hafenlogistik Nord GmbH') if 'Hafenlogistik Nord GmbH' in l else -1
h=l.index('Hans Schmidt') if 'Hans Schmidt' in l else -1
print(c>=0 and h==c+1)" "$LINES")" "True"
rm -rf "$DIR"
summary
