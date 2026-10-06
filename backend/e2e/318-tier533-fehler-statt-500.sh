#!/bin/bash
# Tier 533 — more answers that were a 500
#
# The sweep of all 453 routes with path parameters that are no ids ("x",
# "';--", 3 000 characters, "../../etc") and with bodies of the wrong shape.
# Measured, 500 on:
#   - POST /fints/connections/:id/sync for any unknown connection (the
#     service threw a plain Error) — also the TAN route for an unknown run;
#   - PATCH /webhooks/:id with a list as name / a number as status;
#   - POST /ocr/match-supplier with a list as name;
#   - sending an invoice by e-mail to a customer without an address.
# Now 404 / 400 with the reason.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-318-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier533-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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

note "=== FinTS ==="
AS POST "/api/v1/fints/connections/00000000-0000-0000-0000-000000000000/sync" "{\"companyId\":\"$C\"}"
assert_eq "a sync on an unknown connection: 404 (was 500)" "$STATUS" "404"
assert_eq "…saying so" "$(P "'nicht gefunden' in d['message']")" "True"
AS POST "/api/v1/fints/connections/x/sync" "{\"companyId\":\"$C\",\"daysBack\":\"abc\"}"
assert_eq "…with an id that is none: 404 (was 500)" "$STATUS" "404"

note "=== a webhook ==="
AS POST "/api/v1/webhooks?companyId=$C" '{"url":"https://example.org/hook","events":["invoice.paid"],"name":"Hook"}'
WH=$(json_field "$BODY" id)
[[ -n "$WH" ]] && pass "fixture: a webhook" || fail "webhook: $BODY"
AS PATCH "/api/v1/webhooks/$WH?companyId=$C" '{"name":[]}'
assert_eq "a list as name: 400 (was 500)" "$STATUS" "400"
AS PATCH "/api/v1/webhooks/$WH?companyId=$C" '{"status":5}'
assert_eq "a number as status: 400 (was 500)" "$STATUS" "400"
AS PATCH "/api/v1/webhooks/$WH?companyId=$C" '{"status":"gelöscht"}'
assert_eq "an unknown status: 400 (was stored)" "$STATUS" "400"
AS PATCH "/api/v1/webhooks/$WH?companyId=$C" '{"events":"invoice.paid"}'
assert_eq "events as a text: 400" "$STATUS" "400"
AS PATCH "/api/v1/webhooks/$WH?companyId=$C" '{"name":"Umbenannt","status":"paused"}'
assert_eq "a valid change: stored" "$STATUS/$(P "d['name']")/$(P "d['status']")" "200/Umbenannt/paused"

note "=== OCR: match a supplier ==="
AS POST "/api/v1/ocr/match-supplier?companyId=$C" '{"name":[]}'
assert_eq "a list as name: 400 (was 500)" "$STATUS" "400"
AS POST "/api/v1/ocr/match-supplier?companyId=$C" '{"name":{"a":1},"vatId":5}'
assert_eq "an object and a number: 400 (was 500)" "$STATUS" "400"
AS POST "/api/v1/ocr/match-supplier?companyId=$C" '{"name":"Gibt es nicht GmbH"}'
assert_eq "a name nobody has: answered" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS $BODY")" "ok"

note "=== an invoice by e-mail, the customer has no address ==="
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/send-email?companyId=$C" '{}'
assert_eq "send: 400 (was 500)" "$STATUS" "400"
assert_eq "…saying the customer has no e-mail address" "$(P "'E-Mail-Adresse' in str(d['message'])")" "True"

summary
