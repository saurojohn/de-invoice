#!/bin/bash
# Tier 935 — the advance comes off in the period of the final invoice's supply
#
# A Proforma's payment is declared when received (Tier 470); the final invoice
# declares the whole delivery and takes the advance off (Tier 472) — the
# delivery since Tier 921 in the period of its supply, the advance still on
# the day the final invoice was issued. Measured: Proforma 1 000 paid on the
# 10th of last month, supplied on the 20th, the final invoice issued today —
# Kz 81 last month 2 000 (the advance twice), this month −1 000.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-623-$(date +%s%N | cut -c1-13)"; TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
read -r LM10 LM20 < <(python3 -c "
import datetime as d
t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1)
print(t.replace(day=10).isoformat(), t.replace(day=20).isoformat())")
AS() { local r; r=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$r"|tail -n1); BODY=$(echo "$r"|sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier935-e2e\",\"companyName\":\"$TAG GmbH\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; qq="companyId=$C"
AS PUT "/api/v1/companies/$C?$qq" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?$qq" '{"name":"K","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?$qq" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"$LM10\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?$qq" '{"status":"sent"}'; 
AS POST "/api/v1/invoices/$PI/payments?$qq" "{\"amount\":1190,\"paymentDate\":\"$LM10\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the Proforma paid on $LM10" "$STATUS" "201"
AS POST "/api/v1/invoices/$PI/final-invoice?$qq" "{\"issueDate\":\"$TODAY\"}"; F=$(json_field "$BODY" id)
assert_eq "the final invoice drafted today" "$STATUS" "201"
AS PUT "/api/v1/invoices/$F?$qq" "{\"deliveryDate\":\"$LM20\"}"
assert_eq "…supplied on $LM20" "$STATUS" "200"
AS PUT "/api/v1/invoices/$F/status?$qq" '{"status":"sent"}'
assert_eq "…and issued" "$STATUS" "200"
k() { AS GET "/api/v1/ustva/compute?$qq&year=$1&month=$2"; python3 -c "import sys,json;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('81',0))" "$BODY"; }
assert_eq "Kz 81: last month 1 000 (the advance 1 000 + the delivery 1 000 − the advance; was 2 000), this month 0 (was −1 000)" "$(k ${LM10:0:4} $((10#${LM10:5:2})))/$(k $Y $M)" "1000/0"

summary
