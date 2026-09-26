#!/bin/bash
# Tier 461 — an invoice with payments or credit notes is not simply cancelled
#
# PUT /invoices/:id/status checked no transition. Measured before, a 1 190 €
# invoice paid in full, then set to "cancelled" (200):
#   - UStVA: its 190 € output tax disappeared, though the price was received
#   - EÜR: the 1 000 € income disappeared
#   - DATEV: the invoice AND its payment left the export — 1 190 € gone from
#     the bank account
#   - the customer's money was nowhere: no credit, no refund
# And an invoice with a credit note against it, cancelled: the invoice left
# the returns, the credit note stayed and was still subtracted (in its own
# month). The delete route even pointed there ("Bitte stornieren oder eine
# Gutschrift erstellen").
# Now cancelling is refused while payments or active credit notes exist — the
# correction is a credit note (and a refund of what was paid). An unpaid
# invoice can still be cancelled.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-250-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier461-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
sent() { # net → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
cancel() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"cancelled"}'; }
says() { grep -qi "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
ust() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=6"; py 'print("%g" % d["umsatzsteuer"])'; }

P=$(sent 1000)
AS POST "/api/v1/invoices/$P/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-06-05","paymentMethod":"bank_transfer"}'
G=$(sent 500)
AS POST "/api/v1/invoices/$G/credit-note?companyId=$C" '{"amount":119}'
assert_eq "fixture: a credit note of 119 € on the 595 € invoice" "$STATUS" "201"
O=$(sent 100)
# (the credit note is dated today, not June)
assert_eq "fixture: June output tax 190 + 95 + 19" "$(ust)" "304"

note "=== paid: refused ==="
cancel "$P"
assert_eq "cancelling a paid invoice (was 200)" "$STATUS" "400"
assert_eq "…the message names the credit note" "$(says Gutschrift)" "yes"
AS GET "/api/v1/invoices/$P?companyId=$C"
assert_eq "…it stays paid" "$(json_field "$BODY" status)" "paid"

note "=== with a credit note: refused ==="
cancel "$G"
assert_eq "cancelling an invoice with a credit note (was 200)" "$STATUS" "400"
assert_eq "the June UStVA is unchanged (was 19: both invoices had left it)" "$(ust)" "304"

note "=== unpaid: still possible ==="
cancel "$O"
assert_eq "an unpaid invoice is cancelled" "$STATUS" "200"
assert_eq "…and leaves the UStVA" "$(ust)" "285"

summary
