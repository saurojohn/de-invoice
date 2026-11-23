#!/bin/bash
# Tier 936 — at the year's end an advance is settled with the supply
#
# Measured: a Proforma paid on 05.12. last year, supplied on 15.12., the final
# invoice (with its deduction of the advance) written on 10.01. — the Bilanz
# of 31.12. held the final invoice's whole claim (1 190 €) and the Anzahlung
# (1 000 €) beside it: the settlement counted by the day it was booked. With
# the supply the advance is set off (the GuV already had the revenue).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TAG="e2e-624-$(date +%s%N | cut -c1-13)"; TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; LY=$((Y-1))
AS() { local r; r=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$r"|tail -n1); BODY=$(echo "$r"|sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier936-e2e\",\"companyName\":\"$TAG GmbH\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; qq="companyId=$C"
AS PUT "/api/v1/companies/$C?$qq" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?$qq" '{"name":"K","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?$qq" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?$qq" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?$qq" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
AS POST "/api/v1/invoices/$PI/final-invoice?$qq" "{\"issueDate\":\"$TODAY\"}"; F=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$F/status?$qq" '{"status":"sent"}'
assert_eq "Proforma paid, final invoice issued" "$STATUS" "200"
# shift: Proforma and its payment 05.12. last year, supply 15.12. last year, final invoice and its settlement 10.01. this year
q "update \"Invoice\" set \"issueDate\"='$LY-12-05' where id='$PI'; update \"Payment\" set \"paymentDate\"='$LY-12-05' where \"invoiceId\"='$PI'; update \"Invoice\" set \"issueDate\"='$Y-01-10', \"deliveryDate\"='$LY-12-15' where id='$F'; update \"Payment\" set \"paymentDate\"='$Y-01-10' where \"invoiceId\"='$F'" >/dev/null
AS GET "/api/v1/accounting/bilanz?$qq&year=$LY"
claim=$(P "next(l['amount'] for s in d['aktiva'] for l in s['lines'] if l['label']=='Forderungen aus Lieferungen und Leistungen')")
adv=$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")
ust=$(P "next(l['amount'] for s in d['passiva'] for l in s['lines'] if l['label']=='Sonstige Verbindlichkeiten')")
assert_eq "Bilanz 31.12.$LY: no claim (was 1 190), no Anzahlung (was 1 000), the VAT owed 190" "$claim/$adv/$ust" "0/0/190"
AS GET "/api/v1/accounting/guv?$qq&year=$LY"
assert_eq "…the revenue in $LY, as before" "$(P "d['totals']['umsatzerloese']")" "1000"

summary
