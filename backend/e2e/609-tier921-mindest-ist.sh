#!/bin/bash
# Tier 921 — Mindest-Ist instead of the invoice date
#
# Tier 913 declared an invoice written before its supply (a Vorausrechnung) in
# its own period, in full, paid or not. § 13 Abs. 1 Nr. 1 a UStG: the tax
# arises with the supply; only a payment received before it is owed earlier,
# when received, and only for its amount (Satz 4). Measured: invoices of today
# for deliveries on 05.01. next year — declared this month in full, unpaid
# too (and so in this year's UStJA); the Bilanz then owed the Finanzamt VAT on
# a supply not made.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-609-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; NY=$((Y + 1)); M=$((10#${TODAY:5:2}))
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier921-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 609","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
vorausrechnung() { # net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NY-01-05\",\"items\":[{\"description\":\"Lieferung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }

note "=== an unpaid Vorausrechnung: with the supply ==="
vorausrechnung 1000
assert_eq "this month 0 (was 1 000), January $NY 1 000" "$(kz81 $Y $M)/$(kz81 $NY 1)" "0/1000"

note "=== half of a Vorausrechnung paid today: that half now, the rest with the supply ==="
vorausrechnung 2000
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
PAY=$(json_field "$BODY" id)
assert_eq "paid 1 190" "$STATUS" "201"
assert_eq "this month the 1 000 paid (was 3 000), January the 1 000 + 1 000 still open" "$(kz81 $Y $M)/$(kz81 $NY 1)" "1000/2000"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
anz=$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")
ust=$(P "next(l['amount'] for s in d['passiva'] for l in s['lines'] if l['label']=='Sonstige Verbindlichkeiten')")
assert_eq "Bilanz 31.12.$Y: the Anzahlung 1 000 net and its 190 € VAT — the 1 190 € received; no VAT on what is neither paid nor supplied (was 570)" "$anz/$ust" "1000/190"

note "=== the month submitted: the payment taxed in it is locked ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "UStVA $Y-$M submitted" "$STATUS" "201"
AS DELETE "/api/v1/invoices/$I/payments/$PAY?companyId=$C"
assert_eq "deleting the payment: 400 (was 200 — the submitted return changed under it)" "$STATUS" "400"

summary
