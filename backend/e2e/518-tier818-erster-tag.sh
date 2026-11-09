#!/bin/bash
# Tier 818 — the first-day drill (the production images on an empty database):
# what a new company met in the DATEV preview.
#
#  1. The „Kontenübersicht" showed one signed balance in both columns —
#     8400 „Soll −1 190, Haben 1 190", the totals „Soll 1 428, Haben −1 428"
#     for an invoice of 1 190 € paid and a rent of 476 € paid. Each booking
#     puts its amount on the Soll side of one account and the Haben side of
#     the other; Soll and Haben add up to the same.
#  2. A new company has no Berater- and Mandantennummer: the header carried
#     00000 / 00001, which the adviser's DATEV does not take, and the preview
#     said nothing. It warns now, until both are set.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-518-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier818-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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

AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Hauptstraße 5","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Aufarbeitung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
[[ "$STATUS" == 2* ]] && pass "fixture: an invoice of 1 190 € gross, paid" || fail "payment → $STATUS $BODY"

FROM=$(date +%Y-%m-01)
AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=$FROM&endDate=$TODAY"
assert_eq "the revenue account is credited, the customer debited and credited — no negative column" \
  "$(py "a={x['konto']:x for x in d['byAccount']};r=a.get('8400');print('%.2f/%.2f' % (r['soll'], r['haben']), min(min(x['soll'],x['haben']) for x in d['byAccount']) >= 0)")" \
  "0.00/1190.00 True"
assert_eq "Soll and Haben add up to the same, each the sum of the bookings" \
  "$(py "print('%.2f %.2f %.2f' % (d['totalSoll'], d['totalHaben'], d['balanceDelta']), abs(d['totalSoll']-d['totalAmount'])<0.005)")" \
  "2380.00 2380.00 0.00 True"
assert_eq "every account balances to what it is owed: the bank holds 1 190, the customer nothing" \
  "$(py "print(' '.join('%s=%.2f' % (x['konto'], x['soll']-x['haben']) for x in d['byAccount'] if x['konto'] in ('1200','8400')))")" \
  "1200=1190.00 8400=-1190.00"
assert_eq "the accounts are listed by number" "$(py "k=[x['konto'] for x in d['byAccount']];print(k==sorted(k,key=lambda s:(len(s),s)))")" "True"
assert_eq "a company without Berater- and Mandantennummer is warned" \
  "$(py "print([i['severity'] for i in d['issues'] if 'Berater-Nr.' in i['message']])")" "['warning']"

AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"beraterNr":"12345","mandantenNr":"42"}'
AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=$FROM&endDate=$TODAY"
assert_eq "…and not once both are set" "$(py "print(len([i for i in d['issues'] if 'Berater-Nr.' in i['message']]), d['header']['beraterNr'])")" "0 12345"
summary
