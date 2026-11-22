#!/bin/bash
# Tier 919 — revenue with the supply; an invoice before it is no revenue yet
#
# Tier 913 put revenue at the earlier of the supply and the invoice — right
# for the UStVA (an early invoice is declared early), not for the books: the
# revenue is realised with the supply (§ 252 Abs. 1 Nr. 4 HGB), an invoice
# written before it is a pending contract, paid an erhaltene Anzahlung.
# Measured: two invoices of today for deliveries on 05.01. next year (1 000
# and 2 000 net, the second paid) — GuV this year 3 000, Bilanz a receivable
# of 1 190 and no Anzahlung.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-607-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; NY=$((Y + 1)); M=$((10#${TODAY:5:2}))
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { # suffix rechtsform method
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier919-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"$2\",\"gewinnermittlung\":\"$3\",\"besteuerungsart\":\"soll\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 607","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
vorausrechnung() { # net [paid]
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NY-01-05\",\"items\":[{\"description\":\"Lieferung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  [ -n "${2:-}" ] && AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
}
line() { P "next(l['amount'] for s in d['$1'] for l in s['lines'] if l['label']=='$2')"; }

note "=== a GmbH: two invoices of today for deliveries on 05.01.$NY ==="
company a GmbH bilanz
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
vorausrechnung 1000
vorausrechnung 2000 2380
assert_eq "the second paid in advance" "$STATUS" "201"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV $Y: no revenue yet (was 3 000)" "$(P "d['totals']['umsatzerloese']")" "0"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$NY"
assert_eq "GuV $NY: 3 000, with the supply" "$(P "d['totals']['umsatzerloese']")" "3000"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "Bilanz 31.12.$Y: no receivable for the unpaid one (was 1 190)" "$(line aktiva 'Forderungen aus Lieferungen und Leistungen')" "0"
assert_eq "…the paid one an erhaltene Anzahlung of 2 000 net (was 0; its 380 € VAT are in the Umsatzsteuer owed — Tier 920)" "$(line passiva 'Erhaltene Anzahlungen auf Bestellungen')" "2000"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
# Tier 921: the UStVA declares the paid one when received (Mindest-Ist), the unpaid one with its supply
assert_eq "the UStVA this month: the 2 000 paid in advance, not the unpaid 1 000" "$(P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81')")" "2000"

note "=== a sole trader who keeps books from $NY: the Anzahlung in the Übergangsgewinn ==="
company b Einzelunternehmen euer
vorausrechnung 2000 2380
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"gewinnermittlung\":\"bilanz\",\"gewinnermittlungAb\":$NY}"
assert_eq "Bilanz from $NY" "$STATUS" "200"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR $Y: the 2 380 received" "$(P "f\"{d['totals']['gewinn']:g}\"")" "2380"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$NY"
assert_eq "the Übergang: an Anzahlung of 2 000 net, the VAT of 380 owed" "$(P "(d['uebergang']['anzahlungen'], d['uebergang']['umsatzsteuer'], d['uebergang']['forderungen'])")" "(2000, 380, 0)"
assert_eq "Anlage G $NY: the supply 2 000 less the Übergang 2 380 = −380 — over both years 2 000, once" "$(P "f\"{d['totals']['gewinnVorKorrektur']:g}\"")" "-380"

summary
