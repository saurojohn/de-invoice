#!/bin/bash
# Tier 959 — "Einladung erneut senden"
#
# The resend sent nothing: it answered the admin with the new token in plain
# text and made the mailed link invalid. Measured: the admin accepted the
# invitation of a tax adviser with a password of his own and logged in as
# him — an "active, verified" account in someone else's name; every booking
# under it attributed to a person who never had it (GoBD: each entry traced to
# its author). The new link now goes by mail to the invitee; the answer
# carries no token.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-646-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier959-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company and its admin" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "update \"Company\" set \"emailVerifiedAt\" = now() where id = '$C'" >/dev/null 2>&1
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
valid() { curl -sS "$API/api/v1/invitations/verify?token=$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('valid'))" 2>/dev/null; }

EM="$TAG-stb@example.test"
AS POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$EM\",\"role\":\"berater\"}"
assert_eq "the admin invites a tax adviser" "$STATUS" "201"
INV=$(json_field "$BODY" id)
FIRST=$(invite_token "$EM")
assert_eq "…the mailed link is valid" "$(valid "$FIRST")" "True"

AS POST "/api/v1/users/invitations/$INV/resend?companyId=$C" '{}'
assert_eq "resend" "$STATUS" "201"
assert_eq "…its answer carries no token (was the new token in plain text)" "$(P "'tokenPlain' in d")" "False"
SECOND=$(invite_token "$EM")
assert_eq "…a new link went to the invitee (was none — no mail)" "$([[ -n "$SECOND" && "$SECOND" != "$FIRST" ]] && echo yes || echo no)" "yes"
assert_eq "…it is valid, the old one not" "$(valid "$SECOND")/$(valid "$FIRST")" "True/False"

summary
