#!/bin/bash
# Tier 937 — a Proforma's advance in the Übergangsgewinn
#
# Tier 919 subtracts, at a change from the EÜR to the Bilanz, what was paid in
# advance on an invoice whose supply comes after the change. An advance on a
# Proforma was left out: the EÜR counted it when received, the Bilanz counted
# the whole delivery again with the final invoice. Measured: a Proforma of
# 1 000 + 190 paid this year (EÜR), books from next year, supplied on 05.01.
# — EÜR this year 1 190, Anlage G next year 810: 2 000 for a sale of 1 000.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TAG="e2e-625-$(date +%s%N | cut -c1-13)"; TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; NY=$((Y+1))
AS() { local r; r=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$r"|tail -n1); BODY=$(echo "$r"|sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier937-e2e\",\"companyName\":\"$TAG\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; qq="companyId=$C"
AS PUT "/api/v1/companies/$C?$qq" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"euer","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?$qq" '{"name":"K","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?$qq" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?$qq" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?$qq" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "a Proforma paid this year (EÜR)" "$STATUS" "201"
AS PUT "/api/v1/companies/$C?$qq" "{\"gewinnermittlung\":\"bilanz\",\"gewinnermittlungAb\":$NY}"
assert_eq "books from $NY" "$STATUS" "200"
# the final invoice: written today, supply 05.01. next year (moved by SQL)
AS POST "/api/v1/invoices/$PI/final-invoice?$qq" "{\"issueDate\":\"$TODAY\"}"; F=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$F?$qq" "{\"deliveryDate\":\"$NY-01-05\"}"; AS PUT "/api/v1/invoices/$F/status?$qq" '{"status":"sent"}'
assert_eq "the final invoice, supplied on 05.01.$NY" "$STATUS" "200"
AS GET "/api/v1/accounting/euer?$qq&year=$Y"
E=$(P "d['totals']['gewinn']")
AS GET "/api/v1/accounting/anlage-g?$qq&year=$NY"
assert_eq "the Übergang: the advance of 1 000 net (was 0), the VAT of 190" "$(P "(d['uebergang']['anzahlungen'], d['uebergang']['umsatzsteuer'])")" "(1000, 190)"
assert_eq "EÜR $Y 1 190 + Anlage G $NY −190 = 1 000 — the sale once (was 1 190 + 810)" "$(python3 -c "print(round($E + $(P "d['totals']['gewinnVorKorrektur']"), 2))")" "1000"

summary
