#!/bin/bash
# Tier 514 — reserved payment methods and a payment date in the future
#
# 'Gutschrift' and 'Guthaben' are payment methods the system books — a credit
# note settling its invoice, customer credit applied to an invoice — and they
# count as "no money arrived" (document-scope.ts: not in the EÜR, not on the
# bank). Measured before: POST /invoices/:id/payments took them by hand — an
# invoice was "paid" with no credit note behind it and without touching the
# customer's credit; and a payment dated 2030 was booked (paid today, income
# in the EÜR of 2030).
#
# Now both are refused (400) by hand; applying real customer credit still
# books 'Guthaben'. A payment date after today is refused.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-299-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier514-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=1)).isoformat())")
inv() { # → id of a sent 119 € invoice
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-10\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"$4\"}"; }
state() { q "select status||'/'||(select count(*) from \"Payment\" where \"invoiceId\"='$1') from \"Invoice\" where id='$1'"; }

note "=== reserved methods ==="
A=$(inv)
pay "$A" 119 "$TODAY" Gutschrift
assert_eq "'Gutschrift' by hand: 400 (was 201 — paid without a credit note)" "$STATUS" "400"
assert_eq "…pointing to the credit note" "$(P "'Gutschrift' in d['message'] and 'nicht von Hand' in d['message']")" "True"
pay "$A" 119 "$TODAY" Guthaben
assert_eq "'Guthaben' by hand: 400 (was 201 — paid without any credit used)" "$STATUS" "400"
assert_eq "the invoice is still open, nothing booked" "$(state "$A")" "sent/0"

note "=== the payment date ==="
pay "$A" 119 "$TOMORROW" bank_transfer
assert_eq "tomorrow: 400 (was 201)" "$STATUS" "400"
pay "$A" 119 "2030-01-01" bank_transfer
assert_eq "2030: 400" "$STATUS" "400"
assert_eq "…still open" "$(state "$A")" "sent/0"
pay "$A" 500 "$TODAY" bank_transfer
assert_eq "today, a real transfer (500 € on 119 €): booked" "$STATUS/$(q "select status from \"Invoice\" where id='$A'")" "201/paid"

note "=== real customer credit is still applied as 'Guthaben' ==="
B=$(inv)
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$B\",\"amount\":119}"
assert_eq "381 € of credit from the overpayment: 119 € applied" "$STATUS" "201"
assert_eq "…as a 'Guthaben' payment, the invoice paid" \
  "$(q "select \"paymentMethod\"||'/'||amount::numeric(12,2) from \"Payment\" where \"invoiceId\"='$B'")/$(q "select status from \"Invoice\" where id='$B'")" "Guthaben/119.00/paid"

summary
