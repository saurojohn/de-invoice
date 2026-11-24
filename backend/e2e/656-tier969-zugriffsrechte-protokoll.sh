#!/bin/bash
# Tier 969 — giving and taking access: the inviter's standing, the audit trail
#
# An admin deactivated left his open invitations valid: one he had sent as
# admin still made its holder an admin (who then read GET /users). And
# inviting, resending, cancelling, deactivating and reactivating left no
# audit row (only role changes did); the accepted membership had no actor.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-656-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier969-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company and its owner" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # user method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
valid() { curl -sS "$API/api/v1/invitations/verify?token=$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('valid'))" 2>/dev/null; }
accept() { curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" \
  -d "{\"token\":\"$1\",\"password\":\"Tier969-member\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))"; }

AS "$U" POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-a2@example.test\",\"role\":\"admin\"}"
A2=$(accept "$(invite_token "$TAG-a2@example.test")")
[[ -n "$A2" ]] && pass "fixture: a second admin" || fail "second admin"
AS "$A2" POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-ex@example.test\",\"role\":\"admin\"}"
EXT=$(invite_token "$TAG-ex@example.test")
assert_eq "the second admin invites another admin" "$(valid "$EXT")" "True"
AS "$U" PATCH "/api/v1/users/$A2/status?companyId=$C" '{"status":"inactive"}'
assert_eq "the owner deactivates the second admin" "$STATUS" "200"
assert_eq "…his invitation no longer holds (was valid — an admin planted by one removed)" "$(valid "$EXT")" "False"
AS "$U" PATCH "/api/v1/users/$A2/status?companyId=$C" '{"status":"active"}'
AS "$U" POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-v@example.test\",\"role\":\"viewer\"}"
VINV=$(json_field "$BODY" id)
AS "$U" POST "/api/v1/users/invitations/$VINV/resend?companyId=$C" '{}'
AS "$U" DELETE "/api/v1/users/invitations/$VINV?companyId=$C"

assert_eq "the audit trail: who gave and took access (was none of these rows)" \
  "$(sql "select string_agg(a || ':' || who, ' ' order by a, who) from (select action a, case when \"userId\" = '$U' then 'owner' when \"userId\" = '$A2' then 'admin2' else coalesce(\"userId\", 'none') end who from \"AuditLog\" where \"companyId\" = '$C' and \"entityType\" = 'UserAccess') x")" \
  "invitation.accepted:admin2 invitation.cancelled:owner invitation.created:admin2 invitation.created:owner invitation.created:owner invitation.resent:owner user.deactivated:owner user.reactivated:owner"

summary
