#!/bin/bash
# Tier 887 — a credit note asks for no payment
#
# Found by reading a credit note PDF: it carried a GiroCode for „EUR-500.00“
# — no valid EPC amount, and an app that reads it without the sign prefills
# a transfer of 500 € TO the company that owes the money back. The GiroCode
# PNG was served for it too, and a payment link was minted: the public page
# showed „-500,00 €“ and asked the customer to pay.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-579-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier887-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Commerzbank\"}'::jsonb where id='$C'" >/dev/null
DIR=$(mktemp -d)
rgb_images() { node -e "const t=require('fs').readFileSync(process.argv[1],'latin1');console.log((t.match(/\/Subtype\s*\/Image[^>]*?\/ColorSpace\s*\/DeviceRGB/g)||[]).length)" "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Nachlass 579 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Kessel\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
INV=$(field id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"amount":500,"reason":"Preisnachlass"}'
CN=$(field id)
assert_eq "fixture: a credit note of 500" "$STATUS $(q "select type||' '||total::numeric(12,2) from \"Invoice\" where id='$CN'")" "201 CN -500.00"

curl -sS "$API/api/v1/invoices/$INV/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/inv.pdf"
curl -sS "$API/api/v1/invoices/$CN/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/cn.pdf"
assert_eq "the invoice keeps its GiroCode" "$(rgb_images "$DIR/inv.pdf")" "1"
assert_eq "the credit note has none (was: one for „EUR-500.00“)" "$(rgb_images "$DIR/cn.pdf")" "0"

CODE=$(curl -sS -o "$DIR/g.json" -w "%{http_code}" "$API/api/v1/invoices/$CN/girocode.png?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "no GiroCode PNG for it (was: 200)" "$CODE $(python3 -c "import json;print(json.load(open('$DIR/g.json'))['message'])")" "400 Zu einer Gutschrift gibt es keinen GiroCode — hier zahlen Sie an den Kunden."

AS POST "/api/v1/invoices/$CN/generate-payment-link?companyId=$C" '{}'
assert_eq "no payment link for it (was: a page asking to pay -500,00 €)" "$STATUS $(field message)" "400 Zu einer Gutschrift gibt es keinen Zahlungslink — der Betrag steht dem Kunden zu."
AS POST "/api/v1/invoices/$INV/generate-payment-link?companyId=$C" '{}'
assert_eq "the invoice still gets one" "$STATUS" "201"
rm -rf "$DIR"
summary
