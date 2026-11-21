#!/bin/bash
# Tier 894 — the invoice e-mail asks for what is open
#
# Found by reading the invoice e-mail next to the payment state: it always
# said „anbei erhalten Sie die Rechnung … über {total}. Bitte begleichen Sie
# den Betrag bis zum …“ — for an invoice paid at the counter and e-mailed
# afterwards (an invitation to pay twice), after a down payment, after a
# credit note. The send dialog's text (email-data) is the one sent.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-585-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier894-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Zahler 585 GmbH","type":"business","contact":{"email":"zahler@e585.example"},"address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(field id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
mailtext() { AS GET "/api/v1/invoices/$I/email-data?companyId=$C"; field body; }

T=$(mailtext)
assert_eq "open: asks for the total, as before" \
  "$(echo "$T" | grep -c "über 1.190,00")/$(echo "$T" | grep -c "Bitte begleichen Sie den Betrag bis zum")" "1/1"

AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
T=$(mailtext)
assert_eq "a down payment of 190: what is still open (was: the full 1 190 € asked)" \
  "$(echo "$T" | grep -c "Nach Abzug der bereits geleisteten Zahlungen sind noch 1.000,00")/$(echo "$T" | grep -c "offen. Bitte begleichen Sie diesen Betrag bis zum")/$(echo "$T" | grep -c "Bitte begleichen Sie den Betrag bis zum")" "1/1/0"

AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":1000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"cash\"}"
T=$(mailtext)
assert_eq "paid in full: no request to pay (was: „Bitte begleichen Sie den Betrag“)" \
  "$(echo "$T" | grep -c "Der Betrag ist bereits beglichen — vielen Dank.")/$(echo "$T" | grep -c "begleichen Sie")" "1/0"

AS POST "/api/v1/invoices/$I/send-email?companyId=$C" '{}'
SENT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"bodyPreview\" from \"EmailSend\" where \"companyId\"='$C' order by \"createdAt\" desc limit 1")
assert_eq "the e-mail sent says the same" "$(echo "$SENT" | grep -c "bereits beglichen")" "1"
summary
