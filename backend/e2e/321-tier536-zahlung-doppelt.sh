#!/bin/bash
# Tier 536 — the same payment submitted twice within 10 seconds
#
# Decided by the user (06.10.2026). Measured before: the payment form's
# request sent six times at once (a double click, a client's retry) recorded
# six payments of 119 € on an invoice of 119 € — five of them became customer
# credit (595 €).
#
# Now `POST /invoices/:id/payments` refuses a payment that equals one recorded
# on this invoice in the last 10 seconds — amount, date, method, reference —
# with 409. Another amount, date or reference is another payment; the same
# one again after the 10 seconds too. System bookings are not affected.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-321-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier536-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
H=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" "${H[@]}" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(date +%Y-%m-%d)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
pay() { AS POST "/api/v1/invoices/$I/payments?companyId=$C" "$1"; }
count() { q "select count(*)||'/'||coalesce(sum(amount),0)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$I'"; }
credit() { AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"; P "d['balance']"; }

note "=== six at once ==="
inv 100
B="{\"amount\":119,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"reference\":\"R-1\"}"
D=$(mktemp -d)
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/v1/invoices/$I/payments?companyId=$C" "${H[@]}" -d "$B" > "$D/$i" & done; wait
assert_eq "one recorded, five answered 409 (were six × 201)" "$(cat "$D"/* | sort | uniq -c | tr -s ' ' | tr '\n' ';')" " 1 201; 5 409;"
rm -rf "$D"
assert_eq "…one payment of 119 €, the invoice paid, no credit (were 595 €)" "$(count)/$(q "select status from \"Invoice\" where id='$I'")/$(credit)" "1/119.00/paid/0"

note "=== one after the other ==="
inv 1000
B="{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
pay "$B"; assert_eq "100 € without a reference" "$STATUS" "201"
pay "$B"; assert_eq "the same again at once: 409" "$STATUS" "409"
assert_eq "…saying it was just recorded" "$(P "'gerade eben schon erfasst' in d['message']")" "True"
pay "{\"amount\":100.01,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "another amount: recorded" "$STATUS" "201"
pay "{\"amount\":100,\"paymentDate\":\"2026-09-15\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "another date: recorded" "$STATUS" "201"
pay "{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"reference\":\"zweite Rate\"}"
assert_eq "another reference: recorded" "$STATUS" "201"
pay "{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"cash\"}"
assert_eq "another method: recorded" "$STATUS" "201"
assert_eq "five payments on the invoice" "$(count)" "5/500.01"

note "=== after the 10 seconds ==="
python3 -c "import time;time.sleep(11)"
pay "$B"
assert_eq "the same payment again, 11 seconds later: recorded" "$STATUS/$(count)" "201/6/600.01"

summary
