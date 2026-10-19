#!/bin/bash
# Tier 701 — the payment link says what is left to pay, and when nothing is
#
# The public page of a payment link (/pay/<token>) showed the invoice's total
# and the button "Zahlung melden" whatever had happened to it. Measured: a
# 1 190 € invoice with a 500 € part payment — the page said 1 190 €; a paid
# invoice and one cancelled by its Storno credit note — the page offered the
# button; an invoice cancelled by its status (data before Tier 694) took a
# payment report (201, a notice of 1 190 €).
# Now GET /portal/<token> carries `openAmount` and `settled` ('paid' /
# 'cancelled' / null); the page shows the open amount and, when nothing is
# open, says so instead of the button; a cancelled invoice takes no report.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-425-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier701-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { # method path [body] — no auth
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
issued() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
link() { AS POST "/api/v1/invoices/$1/generate-payment-link?companyId=$C" '{"origin":"http://localhost:3100"}'; P "d.get('token') or d.get('url','').rstrip('/').rsplit('/',1)[-1]"; }
OPEN=$(issued); PART=$(issued); PAID=$(issued); STORNO=$(issued); LEGACY=$(issued)
L_OPEN=$(link "$OPEN"); L_PART=$(link "$PART"); L_PAID=$(link "$PAID"); L_STORNO=$(link "$STORNO"); L_LEGACY=$(link "$LEGACY")
AS POST "/api/v1/invoices/$PART/payments?companyId=$C" '{"amount":500,"paymentDate":"2026-10-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-10-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$STORNO/credit-note?companyId=$C" '{"reason":"Storno"}'
# (an invoice cancelled by its status, as data before Tier 694 has them)
q "update \"Invoice\" set status='cancelled' where id='$LEGACY'" >/dev/null

page() { PUB GET "/api/v1/portal/$1"; P "d['invoice']['total'], d['invoice'].get('openAmount'), d['invoice'].get('settled')"; }
assert_eq "open: 1 190 to pay" "$(page "$L_OPEN")" "('1190', '1190.00', None)"
assert_eq "part paid: 690 left (was: the total only)" "$(page "$L_PART")" "('1190', '690.00', None)"
assert_eq "paid: nothing left, settled 'paid'" "$(page "$L_PAID")" "('1190', '0.00', 'paid')"
assert_eq "cancelled by its Storno: settled 'cancelled' (was: shown as payable)" "$(page "$L_STORNO")" "('1190', '0.00', 'cancelled')"
assert_eq "cancelled by its status: settled 'cancelled'" "$(page "$L_LEGACY")" "('1190', '1190.00', 'cancelled')"

PUB POST "/api/v1/portal/$L_LEGACY/mark-paid" '{}'
assert_eq "a payment report on the cancelled invoice: 400 (was 201, a notice of 1 190)" "$STATUS/$(q "select count(*) from \"PaymentNotice\" where \"invoiceId\"='$LEGACY'")" "400/0"
PUB POST "/api/v1/portal/$L_STORNO/mark-paid" '{}'
assert_eq "…on the Storno'd one: 400, no notice" "$STATUS/$(q "select count(*) from \"PaymentNotice\" where \"invoiceId\"='$STORNO'")" "400/0"
PUB POST "/api/v1/portal/$L_PART/mark-paid" '{}'
assert_eq "the part-paid one: the report is the 690 left" "$STATUS/$(P "d.get('amount')")" "201/690"

PAGE="$SCRIPT_DIR/../../frontend/src/app/pay/[token]/page.tsx"
assert_eq "the page shows the open amount and a settled invoice without the button" \
  "$(grep -c 'data-testid="pay-open"' "$PAGE")/$(grep -c 'data-testid="pay-settled"' "$PAGE")/$(grep -c 'invoice.settled ? (' "$PAGE")" "1/1/1"

summary
