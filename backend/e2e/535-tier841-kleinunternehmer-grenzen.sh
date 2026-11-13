#!/bin/bash
# Tier 841 — the limits of the Kleinunternehmerregelung (§ 19 UStG since 2025).
#
# Measured before: a Kleinunternehmer with 30 000 € received last year and
# 105 000 € this year went on writing invoices without USt, and nothing said
# a word — although last year's 25 000 € end the regulation for this year, and
# this year's 100 000 € end it at once. Now accounting/kleinunternehmer-status
# reports the year's and last year's Gesamtumsatz (the net receipts of the
# EÜR) and what follows; the dashboard and the invoice form show it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1))
company() { # tag mode → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e-535-$1-$(date +%s%N | cut -c1-13)@example.test\",\"password\":\"Tier841-e2e\",\"companyName\":\"e2e-535 $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
setup() { # mode
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"defaultVatMode\":\"$1\",\"rechtsform\":\"Einzelunternehmen\",\"besteuerungsart\":\"ist\"}"
  assert_status 200 "fixture: VAT mode $1"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
paid() { # date net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0}]}"
  local I; I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$1\",\"paymentMethod\":\"bank_transfer\"}"
  assert_status 201 "fixture: $2 € received on $1"
}
status() {
  AS GET "/api/v1/accounting/kleinunternehmer-status?companyId=$C"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['kleinunternehmer'], '%.2f' % d['vorjahr']['umsatz'], '%.2f' % d['laufend']['umsatz'], ' '.join(d['hinweise']) or '-')"
}

note "=== 1. last year over 25 000, this year over 100 000 ==="
read -r U C < <(company over); setup kleinunternehmer
paid "$P-06-02" 30000
paid "$Y-01-01" 60000
assert_eq "last year's 30 000: not a Kleinunternehmer this year; this year's 60 000: nor the next (was: no endpoint, no word)" \
  "$(status)" "True 30000.00 60000.00 vorjahrUeberschritten naechstesJahr"
paid "$Y-01-01" 35000
assert_eq "at 95 000: near the 100 000" "$(status)" "True 30000.00 95000.00 vorjahrUeberschritten laufendNahe naechstesJahr"
paid "$Y-01-01" 10000
assert_eq "at 105 000: over it — regular taxation since the crossing supply" \
  "$(status)" "True 30000.00 105000.00 vorjahrUeberschritten laufendUeberschritten naechstesJahr"

note "=== 2. no revenue last year, 26 000 this year ==="
read -r U C < <(company neu); setup kleinunternehmer
paid "$Y-01-01" 26000
assert_eq "over 25 000 with nothing last year: next year not, and this year already if founded this year" \
  "$(status)" "True 0.00 26000.00 naechstesJahr gruendungsjahr"

note "=== 3. within the limits; not a Kleinunternehmer ==="
read -r U C < <(company klein); setup kleinunternehmer
paid "$P-03-02" 20000
paid "$Y-01-01" 24000
assert_eq "20 000 last year, 24 000 this year: nothing to say" "$(status)" "True 20000.00 24000.00 -"
read -r U C < <(company regel); setup standard
assert_eq "a company with Regelbesteuerung: no figures, nothing to say" "$(status)" "False 0.00 0.00 -"
summary
