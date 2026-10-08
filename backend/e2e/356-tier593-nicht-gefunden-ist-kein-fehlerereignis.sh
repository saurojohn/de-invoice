#!/bin/bash
# Tier 593 — a not-found is not an error event; an unknown bank code is a 400
#
# 1. Prisma's P2025 ("record to update not found") has been answered 404 since
#    Tier 378 — and was still stored as an "unhandled" ErrorEvent with its
#    stack trace, because the filter stored everything that is not an
#    HttpException. PUT / DELETE /webhooks/<another company's id> left such an
#    event on the caller's error page each time (seen in the cross-company
#    test, Tier 592).
# 2. POST /fints/connections with a bank code the server has no address for
#    threw a plain Error: 500 „Internal server error“ instead of the message.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-356-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier593-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
# error events about a request path (the event's own companyId is not always set)
events() { q "select count(*) from \"ErrorEvent\" where url like '%$1%'"; }

company a
[[ -n "${C:-}" ]] && pass "fixture: company A" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/webhooks?companyId=$C" '{"url":"https://example.org/h","events":["invoice.paid"],"name":"'$TAG'"}'
WA=$(json_field "$BODY" id); CA=$C
company b

note "=== 1. a webhook of another company ==="
AS PUT "/api/v1/webhooks/$WA?companyId=$C" '{"name":"x"}'
assert_eq "PUT: 404" "$STATUS" "404"
AS DELETE "/api/v1/webhooks/$WA?companyId=$C"
assert_eq "DELETE: 404" "$STATUS" "404"
AS PUT "/api/v1/webhooks/00000000-0000-0000-0000-000000000000?companyId=$C" '{"name":"x"}'
assert_eq "an id that does not exist: 404" "$STATUS" "404"
assert_eq "…and no error event was stored for any of them (was: one each, with a stack trace)" "$(events "/webhooks/$WA")/$(events "/webhooks/00000000-0000-0000-0000-000000000000?companyId=$C")" "0/0"
assert_eq "A's webhook is untouched" "$(q "select name||'/'||status from \"Webhook\" where id='$WA'")" "$TAG/active"

note "=== 2. a real fault is still stored ==="
BEFORE=$(q "select count(*) from \"ErrorEvent\"")
AS POST "/api/v1/system/errors?companyId=$C" '{"source":"frontend","kind":"unhandled","message":"'$TAG' probe"}'
assert_eq "a reported error is recorded" "$(q "select count(*) > $BEFORE from \"ErrorEvent\"")" "t"

note "=== 3. a bank code without a known address ==="
N=$(events "fints/connections?companyId=$C")
AS POST "/api/v1/fints/connections?companyId=$C" '{"companyId":"'$C'","blz":"12345678","userId":"u","label":"'$TAG'","pin":"12345"}'
assert_eq "400 with the reason (was: 500 Internal server error)" "$STATUS $(echo "$BODY" | grep -c 'Keine FinTS-URL für BLZ 12345678')" "400 1"
assert_eq "…no connection, no error event" "$(q "select count(*) from \"FinTSConnection\" where \"companyId\"='$C'")/$(( $(events "fints/connections?companyId=$C") - N ))" "0/0"
summary
