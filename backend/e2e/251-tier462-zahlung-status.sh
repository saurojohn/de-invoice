#!/bin/bash
# Tier 462 — a payment belongs to an issued invoice
#
# PaymentService.create checked the type (no credit note) and the amount,
# not the status. Measured before:
#   - a cancelled invoice took a 1 190 € payment (201) and turned "paid": the
#     Storno silently undone, its 190 € back in the UStVA
#   - a draft took a payment and went straight to "paid" — an invoice nobody
#     issued, counted in the UStVA and the EÜR
# Every way a payment is booked (invoice page, bank import, cash book, Raten,
# Sammelzahlung, customer credit, payment notices) goes through that method.
# Now a draft or a cancelled document takes no payment; the message says what
# to do (issue it first / book the money as the customer's credit).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-251-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier462-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
draft() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  json_field "$BODY" id
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-06-05","paymentMethod":"bank_transfer"}'; }
status() { AS GET "/api/v1/invoices/$1?companyId=$C"; json_field "$BODY" status; }
says() { grep -qi "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
ust() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=6"; py 'print("%g" % d["umsatzsteuer"])'; }

X=$(draft); AS PUT "/api/v1/invoices/$X/status?companyId=$C" '{"status":"sent"}'
AS PUT "/api/v1/invoices/$X/status?companyId=$C" '{"status":"cancelled"}'
D=$(draft)
assert_eq "fixture: a cancelled invoice and a draft — no output tax" "$(ust)" "0"

note "=== cancelled ==="
pay "$X"
assert_eq "a payment on a cancelled invoice is refused (was 201)" "$STATUS" "400"
assert_eq "…the message points to the customer's credit" "$(says Guthaben)" "yes"
assert_eq "…it stays cancelled (was 'paid')" "$(status "$X")" "cancelled"

note "=== draft ==="
pay "$D"
assert_eq "a payment on a draft is refused (was 201)" "$STATUS" "400"
assert_eq "…the message says to issue it first" "$(says Entwurf)" "yes"
assert_eq "…it stays a draft (was 'paid')" "$(status "$D")" "draft"
assert_eq "the UStVA stays at 0 (was 380)" "$(ust)" "0"

note "=== issued: as before ==="
AS PUT "/api/v1/invoices/$D/status?companyId=$C" '{"status":"sent"}'
pay "$D"
assert_eq "once issued, the payment is booked" "$STATUS" "201"
assert_eq "…and the invoice paid" "$(status "$D")" "paid"

summary
