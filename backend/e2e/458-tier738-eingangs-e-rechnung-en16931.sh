#!/bin/bash
# Tier 738 — a received e-invoice is checked against EN 16931, by itself
#
# The import read the XML and checked sums and mandatory details; the
# official validator (KoSIT) ran only when someone pressed „Offiziell prüfen“,
# and then with the XRechnung scenarios: a Peppol BIS or plain EN 16931 UBL
# invoice was REJECTED for BR-DE-21 alone („should be an XRechnung") — which
# a received invoice need not be (§ 14 Abs. 1 UStG asks for EN 16931). Now:
#   1. scenarios-en16931.xml: the scenarios of scenarios.xml without the
#      XRechnung step (kept in step — checked here);
#   2. preview and import run it and answer `en16931`; an invoice that breaks
#      the rules can still be booked, its note says so with the rules;
#   3. „Offiziell prüfen“ (POST e-invoice/validate) checks EN 16931 too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-458-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
D=$(mktemp -d)
KOSIT="$SCRIPT_DIR/../../infra/kosit"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

note "=== 1. the EN 16931 scenarios are the issuing ones without the XRechnung step ==="
locs() { grep -o '<location>[^<]*' "$1" | sed 's/<location>//' | sort -u; }
matches() { grep -o '<match>[^<]*' "$1" | sort; }
assert_eq "the same documents matched (UBL invoice, UBL credit note, CII)" "$(matches "$KOSIT/scenarios-en16931.xml" | tr '\n' ' ')" "$(matches "$KOSIT/scenarios.xml" | tr '\n' ' ')"
assert_eq "the same schemas and rules, less the XRechnung schematron" \
  "$(locs "$KOSIT/scenarios-en16931.xml" | tr '\n' ' ')" "$(locs "$KOSIT/scenarios.xml" | grep -v 'XRechnung-UBL-validation' | tr '\n' ' ')"

register() { # suffix → "U C"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier738-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
read -r UA CA < <(register seller)
read -r UB CB < <(register buyer)
fixture_issuer "$CA" DE811907980
fixture_issuer "$CB" DE136695976
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
# a complete issuer, so that nothing but the document is in question (as spec 352)
ISSUER='{"legalName":"Tier 738 Verkauf GmbH","registerEntry":"HRB 12345 Amtsgericht Berlin","email":"info@t738.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS "$UA" "$CA" PUT "/api/v1/companies/$CA?companyId=$CA" "$ISSUER"
CUST="{\"name\":\"$TAG buyer GmbH\",\"type\":\"business\",\"vatId\":\"DE136695976\",\"contact\":{\"email\":\"einkauf@t738.example\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
AS "$UA" "$CA" POST "/api/v1/customers?companyId=$CA" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Beratung\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS "$UA" "$CA" POST "/api/v1/invoices?companyId=$CA" "$INV"
I=$(json_field "$BODY" id)
AS "$UA" "$CA" PUT "/api/v1/invoices/$I/status?companyId=$CA" '{"status":"sent"}'
curl -sS -o "$D/xr.xml" -H "x-user-id: $UA" -H "x-company-id: $CA" "$API/api/v1/invoices/$I/xrechnung?companyId=$CA"
curl -sS -o "$D/zf.pdf" -H "x-user-id: $UA" -H "x-company-id: $CA" "$API/api/v1/invoices/$I/zugferd?companyId=$CA"
grep -q 'xrechnung_3' "$D/xr.xml" && pass "fixture: the seller's XRechnung and ZUGFeRD" || { fail "fixture: no XRechnung"; summary; exit 1; }
# the same invoice as Peppol BIS: only the specification identifier differs
sed -e 's#<cbc:CustomizationID>[^<]*#<cbc:CustomizationID>urn:cen.eu:en16931:2017\#compliant\#urn:fdc:peppol.eu:2017:poacc:billing:3.0#' \
    -e 's#<cbc:ProfileID>[^<]*#<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0#' "$D/xr.xml" > "$D/peppol.xml"
# …and one whose amount due contradicts its total (BR-CO-16), with its own number
python3 - "$D" <<'PY'
import re, sys
d = sys.argv[1]; s = open(d + '/xr.xml', encoding='utf-8').read()
s = re.sub(r'(<cbc:PayableAmount currencyID="EUR">)[0-9.]+', r'\g<1>1.00', s, count=1)
s = re.sub(r'(<cbc:ID>)([^<]+)(</cbc:ID>)', lambda m: m.group(1) + m.group(2) + '-X' + m.group(3), s, count=1)
open(d + '/broken.xml', 'w', encoding='utf-8').write(s)
PY

send() { # route file [curl args…] → STATUS, $D/out
  local route="$1" file="$2"; shift 2
  STATUS=$(curl -s -o "$D/out" -w '%{http_code}' -m 120 -X POST "$API/api/v1/expenses/e-invoice/$route?companyId=$CB" \
    -H "x-user-id: $UB" -H "x-company-id: $CB" -F "file=@$file" "$@")
}
out() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$D/out" "$1" 2>/dev/null; }

note "=== 2. preview: the verdict comes with it ==="
# the validator needs its jar and a Java runtime (the backend looks in
# infra/java first, then JAVA_HOME, then /usr/bin/java)
send preview "$D/xr.xml"
if [[ ! -f "$KOSIT/validator.jar" ]] || ! { ls "$KOSIT"/../java/jdk*/Contents/Home/bin/java >/dev/null 2>&1 || [[ -x "${JAVA_HOME:-/nonexistent}/bin/java" ]] || [[ -x /usr/bin/java ]]; }; then
  assert_eq "without the validator the preview says it did not check" "$STATUS/$(out "d['en16931']['checked']")" "200/False"
  note "KoSIT validator not installed here — the official checks are skipped"
  summary; exit $?
fi
assert_eq "the XRechnung: EN 16931 valid" "$STATUS/$(out "(d['en16931']['valid'], d['en16931']['acceptance'], d['importable'])")" "200/(True, 'ACCEPTABLE', True)"
send preview "$D/peppol.xml"
assert_eq "the same invoice as Peppol BIS: valid (was REJECT for BR-DE-21 alone)" \
  "$(out "(d['invoice']['profile'], d['en16931']['valid'], [e['rule'] for e in d['en16931']['errors']])")" "('Peppol BIS Billing 3.0', True, [])"
send preview "$D/zf.pdf"
assert_eq "the ZUGFeRD PDF (its CII): valid" "$(out "(d['source'], d['en16931']['valid'])")" "('pdf', True)"
send preview "$D/broken.xml"
assert_eq "an amount due against the total: not valid, BR-CO-16 named — and still importable" \
  "$(out "(d['en16931']['valid'], 'BR-CO-16' in [e['rule'] for e in d['en16931']['errors']], d['importable'])")" "(False, True, True)"

note "=== 3. import: the verdict in the response and in the expense's note ==="
send import "$D/broken.xml"
assert_eq "imported: 201, the verdict with it" "$STATUS/$(out "d['en16931']['valid']")" "201/False"
E=$(out "d['expenseIds'][0]")
assert_eq "the note: when it was checked, and what broke" \
  "$(q "SELECT notes LIKE '%EN 16931 geprüft am $(date +%d.%m.%Y) (KoSIT): nicht gültig — %BR-CO-16%' FROM \"Expense\" WHERE id='$E';")" "t"
send import "$D/peppol.xml"
E2=$(out "d['expenseIds'][0]")
assert_eq "a valid one: its note says so" "$(q "SELECT notes LIKE '%EN 16931 geprüft am % (KoSIT): gültig%' FROM \"Expense\" WHERE id='$E2';")" "t"

note "=== 4. „Offiziell prüfen“: EN 16931 too ==="
send validate "$D/peppol.xml"
assert_eq "the Peppol invoice: ACCEPTABLE (was REJECT, BR-DE-21)" "$STATUS/$(out "(d['acceptance'], [e['rule'] for e in d['errors']])")" "200/('ACCEPTABLE', [])"
send validate "$D/broken.xml"
assert_eq "the broken one: REJECT, BR-CO-16" "$(out "(d['acceptance'], 'BR-CO-16' in [e['rule'] for e in d['errors']])")" "('REJECT', True)"

summary
