#!/bin/bash
# Tier 924 — a paid Vorausrechnung cancelled before its supply
#
# Tier 921 declares a payment received before the supply when received;
# Tier 923 put the credit note of a Vorausrechnung at the supply. Measured,
# paid in full and cancelled before the delivery on 05.01. next year: UStVA
# this month +1 000 €, January −1 000 € — the tax of the advance stayed
# declared until the date of a delivery that will not come; the Bilanz owed
# the money twice, as an Anzahlung (1 000) and as the customer's credit
# (1 190), and the VAT (190) besides.
# § 17 Abs. 2 Nr. 2 UStG: the advance is to be given back — the part paid is
# corrected in the period of the credit note, the rest with the supply; the
# Anzahlung is a customer credit now.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-612-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; NY=$((Y + 1)); M=$((10#${TODAY:5:2}))
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier924-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 612","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
vorausrechnung() { # net paid
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NY-01-05\",\"items\":[{\"description\":\"Lieferung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
}
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }
passiva() { P "sum(l['amount'] or 0 for s in d['passiva'] for l in s['lines'] if l['label'].startswith('$1'))"; }

note "=== paid in full, cancelled before the delivery ==="
vorausrechnung 1000 1190
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{}'
assert_eq "the Storno" "$STATUS" "201"
assert_eq "UStVA this month 0 (was +1 000), January $NY 0 (was −1 000)" "$(kz81 $Y $M)/$(kz81 $NY 1)" "0/0"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "Bilanz: no Anzahlung (was 1 000), the customer's credit 1 190, no VAT owed (was 190)" \
  "$(passiva 'Erhaltene Anzahlungen')/$(passiva 'Verbindlichkeiten aus Lieferungen und Leistungen gegenüber Kunden')/$(passiva 'Sonstige Verbindlichkeiten')" "0/1190/0"

note "=== half paid, cancelled: the half paid now, the half open with the supply ==="
vorausrechnung 2000 1190
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{}'
assert_eq "UStVA this month still 0 (+1 000 paid, −1 000 of it taken back), January 0 (+1 000 open, −1 000)" "$(kz81 $Y $M)/$(kz81 $NY 1)" "0/0"

summary
