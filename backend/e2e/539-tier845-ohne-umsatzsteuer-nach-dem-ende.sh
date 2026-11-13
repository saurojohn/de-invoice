#!/bin/bash
# Tier 845 — invoices issued without USt on a day the Kleinunternehmer-
# regelung no longer covers are listed.
#
# Measured before: a Kleinunternehmer's § 19 invoices of this year, then the
# end of the regulation set back to 31.12. of last year (Tier 843's advice
# once last year was over 25 000 €: „Umsatzsteuer ab dem 01.01.“). The
# invoices stood in the UStVA and the EÜR as tax-free and nothing said a word.
# They are taxed supplies: the tax is in their price and owed. Now
# accounting/kleinunternehmer-status lists them — also for the company that
# is no Kleinunternehmer any more — until a Storno has taken each one back.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1)); TODAY=$(TZ=Europe/Berlin date +%F)
TAG="e2e-539-$(date +%s%N | cut -c1-13)"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
company() { # tag mode → U C K
  local reg="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier845-e2e\",\"companyName\":\"$TAG $1\"}"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$reg" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
  fixture_issuer "$C"
  local co="{\"defaultVatMode\":\"$2\",\"rechtsform\":\"Einzelunternehmen\",\"besteuerungsart\":\"soll\"}"
  AS PUT "/api/v1/companies/$C?companyId=$C" "$co"
  assert_status 200 "fixture: $1 ($2)"
  local cu='{"name":"Kunde 539 GmbH","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
  AS POST "/api/v1/customers?companyId=$C" "$cu"; K=$(json_field "$BODY" id)
}
issued() { # date net rate [notes] → I N
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$1\"${4:+,\"notes\":\"$4\"},\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$b"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  assert_status 200 "fixture: $2 € issued on $1"
}
ohne() { # → "anzahl summe [numbers] hint?"
  AS GET "/api/v1/accounting/kleinunternehmer-status?companyId=$C"
  echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin); o=d.get('ohneUmsatzsteuer') or {}
print(o.get('anzahl'), '%.2f' % o.get('summe', 0), [r['invoiceNumber'] for r in o.get('rechnungen', [])], 'ohneUmsatzsteuer' in d.get('hinweise', []))"
}

note "=== 1. § 19 invoices, then the end of the regulation set back over two of them ==="
company ende kleinunternehmer
issued "$P-03-02" 1000 0.19; N1=$N
issued "$P-08-04" 2000 0.19; I2=$I; N2=$N
issued "$P-09-01" 300 0.19 "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."; N3=$N
assert_eq "a Kleinunternehmer since always: none" "$(ohne)" "0 0.00 [] False"
SWITCH="{\"defaultVatMode\":\"standard\",\"kleinunternehmerBis\":\"$P-06-30\"}"
AS PUT "/api/v1/companies/$C?companyId=$C" "$SWITCH"
assert_status 200 "Umsatzsteuer from 01.07.$P"
assert_eq "the two invoices after 30.06. are listed; the one of March stays § 19 (was: no such list)" \
  "$(ohne)" "2 2300.00 ['$N2', '$N3'] True"
AS GET "/api/v1/accounting/kleinunternehmer-status?companyId=$C"
assert_eq "…for a company that is no Kleinunternehmer any more, with date and amount" \
  "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['ohneUmsatzsteuer']['rechnungen'][0];print(d['kleinunternehmer'], r['issueDate'], r['total'])")" "False $P-08-04 2000"

note "--- what is not listed ---"
issued "$TODAY" 500 0.19
issued "$TODAY" 700 0 "Steuerfrei nach § 4 Nr. 21 UStG"
assert_eq "a taxed invoice and one that names its exemption: not listed" "$(ohne)" "2 2300.00 ['$N2', '$N3'] True"

note "--- a Storno takes one back ---"
AS POST "/api/v1/invoices/$I2/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_status 201 "the Storno of $N2"
assert_eq "one left" "$(ohne)" "1 300.00 ['$N3'] True"

note "=== 2. a regular company that never was a Kleinunternehmer ==="
company regel standard
issued "$TODAY" 700 0 "Steuerfrei nach § 4 Nr. 21 UStG"
assert_eq "nothing listed, no hint" "$(ohne)" "0 0.00 [] False"

note "=== 3. a Kleinunternehmer only since 01.07. of last year ==="
company spaet standard
issued "$P-02-03" 400 0 "Steuerfrei nach § 4 Nr. 21 UStG"
SWITCH="{\"defaultVatMode\":\"kleinunternehmer\",\"kleinunternehmerAb\":\"$P-07-01\"}"
AS PUT "/api/v1/companies/$C?companyId=$C" "$SWITCH"
assert_status 200 "a Kleinunternehmer since 01.07.$P"
issued "$P-08-04" 900 0.19
assert_eq "his § 19 invoice and the earlier one with its exemption: not listed" "$(ohne)" "0 0.00 [] False"
SWITCH="{\"kleinunternehmerAb\":\"$P-09-01\"}"
AS PUT "/api/v1/companies/$C?companyId=$C" "$SWITCH"
assert_status 200 "…then only since 01.09.$P"
assert_eq "the invoice of August is now before the regulation: listed" "$(ohne | cut -d' ' -f1,2,4)" "1 900.00 True"
summary
