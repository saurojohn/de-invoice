#!/bin/bash
# Tier 843 — no invoice under § 19 past the Kleinunternehmer's limits.
#
# Measured before (Tier 842): a Kleinunternehmer with 30 000 € received last
# year, or with 99 000 € received this year issuing 1 500 € more, issued the invoice
# without USt and with the § 19 note — only the dashboard's notice (Tier 841)
# said anything. The USt is owed all the same (out of the price, as the
# invoice shows none). Now issuing such an invoice — by hand or by a recurring
# run that issues (the e-mail path issues by the same updateStatus) — is refused, and says what to do: the
# Umsatzsteuer from 01.01. (last year over 25 000 €) or from the day of the
# supply that crosses this year's 100 000 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1)); TODAY=$(TZ=Europe/Berlin date +%F)
company() { # tag → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e-537-$1-$(date +%s%N | cut -c1-13)@example.test\",\"password\":\"Tier843-e2e\",\"companyName\":\"e2e-537 $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
setup() {
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer","rechtsform":"Einzelunternehmen","besteuerungsart":"ist"}'
  assert_status 200 "fixture: a Kleinunternehmer"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
draft() { # date net → I
  local body="{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$body"
  I=$(json_field "$BODY" id)
}
issue() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; }
pay() { # id date amount
  AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$3,\"paymentDate\":\"$2\",\"paymentMethod\":\"bank_transfer\"}"
  assert_status 201 "fixture: $3 € received on $2"
}
paid() { # date net
  draft "$1" "$2"; issue "$I"; assert_status 200 "fixture: $2 € issued on $1"; pay "$I" "$1" "$2"
}
state() { AS GET "/api/v1/invoices/$1?companyId=$C"; echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], '%.2f' % float(d['totalVat']), '%.2f' % float(d['total']))"; }
msg() { echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('message',''))"; }
has() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: $2"; }

note "=== 1. last year 30 000 € received: § 19 does not apply this year ==="
read -r U C < <(company vorjahr); setup
paid "$P-06-02" 30000
draft "$Y-01-02" 1000
issue "$I"
assert_status 400 "issuing a 1 000 € invoice under § 19 this year is refused (was: 200, without USt)"
M=$(msg)
has "it says why: last year's Gesamtumsatz over 25 000 €" "$M" "Die Kleinunternehmerregelung gilt $Y nicht: Der Gesamtumsatz $P betrug 30.000,00 €"
has "and what to do: the Umsatzsteuer from 01.01.$Y" "$M" "Umsatzsteuer ab dem 01.01.$Y ein"
assert_eq "the invoice stays a draft without USt" "$(state "$I")" "draft 0.00 1000.00"

has "a draft of an earlier day is made anew (it can no longer be edited)" "$M" "die Rechnung neu anlegen"

note "--- the way out: Umsatzsteuer from 01.01., the invoice made anew ---"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"defaultVatMode\":\"standard\",\"kleinunternehmerBis\":\"$P-12-31\"}"
assert_status 200 "the settings: Umsatzsteuer from 01.01.$Y"
draft "$Y-01-02" 1000
issue "$I"
assert_status 200 "the invoice made anew is issued"
assert_eq "with its USt" "$(state "$I")" "sent 190.00 1190.00"

note "=== 2. this year's 100 000 €: the supply that crosses them is taxed ==="
read -r U C < <(company laufend); setup
paid "$Y-01-02" 99000
draft "$Y-01-02" 500
issue "$I"
assert_status 200 "99 000 € received + 500 €: still within the 100 000 € (no revenue last year is no refusal)"
draft "$Y-01-03" 1500
issue "$I"
assert_status 400 "99 000 € received + 1 500 €: the invoice that crosses the limit is refused (was: 200, without USt)"
M=$(msg)
has "it says so, with the figures" "$M" "Mit dieser Rechnung (netto 1.500,00 €) übersteigt der Gesamtumsatz $Y 100.000,00 €: vereinnahmt sind bereits 99.000,00 €"
has "and from when: the day of that invoice" "$M" "Umsatzsteuer ab dem 03.01.$Y ein"
assert_eq "it stays a draft" "$(state "$I")" "draft 0.00 1500.00"

note "--- a recurring template that issues its invoices: the run is refused as well ---"
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$K\",\"name\":\"Wartung\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"$TODAY\",\"invoiceStatus\":\"sent\",\"sendEmail\":false,\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":2000,\"vatRate\":0.19}]}"
T=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
[[ "$STATUS" == 400 ]] && pass "a 2 000 € run on top of 99 000 € received is refused (was: an issued invoice without USt)" || fail "run: HTTP $STATUS $BODY"
has "with the same reason" "$(msg)" "übersteigt der Gesamtumsatz $Y 100.000,00 €"
AS GET "/api/v1/invoices?companyId=$C&limit=100"
assert_eq "no invoice came of it" "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('data',d) if isinstance(d,dict) else d;print(len([x for x in r if x.get('recurringInvoiceId')]))")" "0"

note "=== 3. after the crossing: every later one ==="
read -r U C < <(company danach); setup
draft "$Y-01-02" 60000; A=$I; issue "$A"; assert_status 200 "fixture: 60 000 € issued"
draft "$Y-01-02" 45000; B=$I; issue "$B"; assert_status 200 "fixture: 45 000 € issued (60 000 € not yet received)"
pay "$A" "$Y-01-02" 60000; pay "$B" "$Y-01-02" 45000
draft "$Y-01-05" 100
issue "$I"
assert_status 400 "105 000 € received: a 100 € invoice is refused"
has "the limit is behind: since the crossing supply" "$(msg)" "Der Gesamtumsatz $Y hat 100.000,00 € überschritten: vereinnahmt sind 105.000,00 €"
summary
