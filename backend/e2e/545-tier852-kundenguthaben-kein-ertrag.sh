#!/bin/bash
# Tier 852 — a customer credit is owed to the customer, not income.
#
# Measured before (a cross-check of the annual reports, 17.11.2026): a paid
# 595 € invoice cancelled with a Storno (595 € owed back to the customer) and
# a 31 € overpayment put 626 € of „sonstige betriebliche Erträge“ into the
# GuV and the BWA. The balance sheet showed the same 626 € as a liability, and
# the KSt 1 and GewSt start from the GuV's result — both taxed the refund.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$(TZ=Europe/Berlin date +%-m)
TAG="e2e-545-$(date +%s%N | cut -c1-13)"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier852-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"rechtsform":"GmbH","defaultVatMode":"standard","besteuerungsart":"soll"}'
assert_status 200 "fixture: a GmbH"
AS POST "/api/v1/customers?$q" '{"name":"Kunde 545 GmbH","type":"business","address":{"street":"S 1","postalCode":"10115","city":"Berlin","country":"DE"}}'; K=$(json_field "$BODY" id)
invoice() { # net → I
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  AS POST "/api/v1/invoices?$q" "$b"; I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
}
pay() { local b="{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"; AS POST "/api/v1/invoices/$1/payments?$q" "$b"; }

invoice 500; A=$I; pay "$A" 595
assert_status 201 "fixture: 595 € paid"
AS POST "/api/v1/invoices/$A/credit-note?$q" '{"reason":"Storno"}'
assert_status 201 "fixture: …then cancelled — 595 € owed back"
invoice 100; pay "$I" 150
assert_status 201 "fixture: 150 € received on a 119 € invoice — 31 € owed back"
AS GET "/api/v1/customers/$K/credit-balance?$q"
CREDIT=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('balance', d.get('creditBalance', '')))" 2>/dev/null)
[[ "$CREDIT" == "626" || "$CREDIT" == "626.0" ]] && pass "fixture: the customer's credit is 626 €" || note "credit balance endpoint said: $CREDIT"

AS GET "/api/v1/accounting/guv?$q&year=$Y"
assert_eq "GuV: no „sonstige betriebliche Erträge“ (was: 626 €)" \
  "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print([l['amount'] for l in d['revenue']['lines'] if l['label'] == 'Sonstige betriebliche Erträge'])")" "[0]"
assert_eq "GuV: Umsatzerlöse 100 € (500 − 500 + 100), Betriebsleistung 100 € (was: 726)" \
  "$(echo "$BODY" | python3 -c "import sys,json;t=json.load(sys.stdin)['totals'];print(t['umsatzerloese'], t['betriebsleistung'])")" "100 100"
AS GET "/api/v1/reports/bwa?$q&year=$Y&month=$M"
assert_eq "BWA: Erlöse of the year 100 € (was: 726)" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['totals']['erloeseYtd'])")" "100"
AS GET "/api/v1/accounting/kst1?$q&year=$Y"
assert_eq "KSt 1: the income before taxes is 100 € (was: 726)" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['totals']['zve'])")" "100"
AS GET "/api/v1/accounting/bilanz?$q&year=$Y"
assert_eq "the balance sheet still owes the customer the 626 €" \
  "$(echo "$BODY" | python3 -c "
import sys,json
def walk(o):
    if isinstance(o, dict):
        if 'Kunden' in str(o.get('label', '')) and isinstance(o.get('amount'), (int, float)): yield o['amount']
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
print(sum(walk(json.load(sys.stdin)['passiva'])))")" "626"
summary
