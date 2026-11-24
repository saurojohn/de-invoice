#!/bin/bash
# Tier 985 — the XRechnung's payment terms (BT-20) say what the invoice says
#
# BT-20 was „Zahlbar innerhalb von 30 Tagen“ whenever no Skonto was set: an
# invoice due in 14 days carried DueDate (BT-9) 14 days out and „30 Tagen“ in
# its terms, while the PDF said „Zahlbar bis zum …“; a credit note — money
# owed to the customer — carried the same sentence. A receiver's AP software
# reads BT-20.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-672-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-1d +%F 2>/dev/null || TZ=Europe/Berlin date -d '1 day ago' +%F)
DUE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=14))" "$D")
DUE_DE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1]).strftime('%d.%m.%Y'))" "$DUE")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier985-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde GmbH","type":"business","vatId":"DE123456789","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: issued, due $DUE" "$STATUS/$(json_field "$BODY" dueDate | cut -c1-10)" "200/$DUE"
terms() { python3 -c "import re,sys;m=re.search(r'<cac:PaymentTerms>\s*<cbc:Note>([^<]*)</cbc:Note>',sys.argv[1]);print(m.group(1).strip() if m else '-')" "$1"; }
AS GET "/api/v1/invoices/$I/xrechnung?companyId=$C"
assert_eq "BT-20 names the due date, as the PDF (was: Zahlbar innerhalb von 30 Tagen)" "$(terms "$BODY")" "Zahlbar bis zum $DUE_DE ohne Abzug."
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":50,"reason":"Gutschrift"}'
CN=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$CN/xrechnung?companyId=$C"
assert_eq "the credit note carries no payment terms (was: Zahlbar innerhalb von 30 Tagen)" "$STATUS/$(terms "$BODY")" "200/-"

summary
