#!/bin/bash
# Tier 510 — a Mahnungspause holds manual and bulk reminders too
#
# A Mahnungspause (Tier 64) is set when dunning must stop — a dispute, an
# agreed delay. The overdue list and the automatic run respect it. Measured
# before: the send paths did not — POST /reminders/send (the invoice page's
# "Mahnung senden") and POST /reminders/bulk-send dunned a paused invoice and
# a paused customer's invoice all the same, with fees.
#
# Now sendOne refuses them (manual: 400 saying which pause; bulk: a "failed"
# row with the reason, the others go out); ending the pause frees them.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-296-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier510-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
customer() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"contact\":{\"email\":\"$1-$TAG@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"; json_field "$BODY" id; }
overdue() { # customer
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-31\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  q "update \"Invoice\" set \"dueDate\"='2026-08-31' where id='$id'" >/dev/null
  echo "$id"
}
send() { AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$1\",\"level\":\"first\",\"createdById\":\"$U\"}"; }
mahnungen() { q "select count(*) from \"Mahnung\" where \"invoiceId\"='$1'"; }
KA=$(customer a); KB=$(customer b)
I_PAUSED=$(overdue "$KA"); I_FREE=$(overdue "$KA"); I_CUST=$(overdue "$KB")
AS POST "/api/v1/mahnungspausen?companyId=$C" "{\"invoiceId\":\"$I_PAUSED\",\"reason\":\"Reklamation\",\"pausedFrom\":\"2026-09-01\"}"
PAUSE=$(json_field "$BODY" id)
AS POST "/api/v1/mahnungspausen?companyId=$C" "{\"customerId\":\"$KB\",\"reason\":\"Stundung vereinbart\",\"pausedFrom\":\"2026-09-01\"}"
[[ -n "$PAUSE" ]] && pass "fixture: one invoice paused, one customer paused" || fail "pause: $BODY"

note "=== a manual reminder ==="
send "$I_PAUSED"
assert_eq "the paused invoice: refused (was 201)" "$STATUS" "400"
assert_eq "…naming the pause" "$(P "'Mahnungspause' in d.get('message', '') and 'Reklamation' in d.get('message', '')")" "True"
send "$I_CUST"
assert_eq "the paused customer's invoice: refused (was 201)" "$STATUS" "400"
assert_eq "no Mahnung was created for either" "$(mahnungen "$I_PAUSED")/$(mahnungen "$I_CUST")" "0/0"

note "=== the bulk run ==="
AS POST "/api/v1/reminders/bulk-send" "{\"companyId\":\"$C\",\"invoiceIds\":[\"$I_PAUSED\",\"$I_FREE\",\"$I_CUST\"],\"level\":\"first\",\"createdById\":\"$U\"}"
assert_eq "only the free invoice is dunned" \
  "$(P "sorted((r['invoiceId'], r['status']) for r in d['results'])" | tr -d "'")" \
  "$(python3 -c "print(sorted([('$I_PAUSED','failed'),('$I_FREE','sent'),('$I_CUST','failed')]))" | tr -d "'")"

note "=== the pause ended ==="
AS DELETE "/api/v1/mahnungspausen/$PAUSE?companyId=$C"
send "$I_PAUSED"
assert_eq "the invoice can be dunned again" "$STATUS" "201"

summary
