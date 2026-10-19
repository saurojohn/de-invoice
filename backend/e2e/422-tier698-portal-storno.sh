#!/bin/bash
# Tier 698 — the customer portal shows a cancelled invoice as cancelled
#
# Since Tier 694 an issued invoice is cancelled by a credit note over its full
# amount, which settles it: its status is "paid". The customer portal showed
# the status as stored — "Bezahlt" for an invoice the customer never paid,
# next to the credit note. It shows "Storniert" (status `cancelled`) now, in
# the list and on the invoice's page; a partial credit note changes nothing,
# and nothing is open.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-422-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier698-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { # method path — no auth (portal)
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
issued() { # net → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
STORNO=$(issued 1000); PART=$(issued 500); PAID=$(issued 100)
AS POST "/api/v1/invoices/$STORNO/credit-note?companyId=$C" '{"reason":"Storno"}'
AS POST "/api/v1/invoices/$PART/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" '{"amount":119,"paymentDate":"2026-10-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
TOKEN=$(python3 -c "
import sys,json,urllib.parse as u
d=json.loads(sys.argv[1]); url=d.get('url','')
print(u.parse_qs(u.urlparse(url).query).get('token',[''])[0] or d.get('token',''))" "$BODY")
[[ -n "$TOKEN" ]] && pass "fixture: a Storno, a partial credit note, a paid invoice; a portal session" || fail "portal session: $BODY"

PUB GET "/api/v1/customer-portal/invoices?token=$TOKEN"
row() { P "[(i['status'], i['openAmount']) for i in d['invoices'] if i['id']=='$1'][0]"; }
assert_eq "the cancelled invoice: Storniert, nothing open (was: paid)" "$(row "$STORNO")" "('cancelled', '0')"
assert_eq "the partially credited one: open as before" "$(row "$PART")" "('sent', '476')"
assert_eq "the paid one: paid" "$(row "$PAID")" "('paid', '0')"
assert_eq "…the tiles: open 476, paid 119 (no credit note counted as payment)" \
  "$(P "[(s['totalOpen'], s['totalPaid']) for s in d.get('summaryByCurrency', [d.get('summary', {})]) ][0]")" "(476, 119)"
PUB GET "/api/v1/customer-portal/invoice/$STORNO?token=$TOKEN"
assert_eq "its page: Storniert (was: paid), and no internal field more" "$(P "d['status'], 'creditNotes' in d")" "('cancelled', False)"
PUB GET "/api/v1/customer-portal/invoice/$PAID?token=$TOKEN"
assert_eq "the paid one's page: paid" "$(P "d['status']")" "paid"

summary
