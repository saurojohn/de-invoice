#!/bin/bash
# Tier 990 — a FinTS sync that brings nothing new makes no statement
#
# Demo connection, TAN, then three more syncs with nothing new: four
# BankStatement rows (3, 0, 0, 0 transactions), all listed. The 4-hour cron
# takes the same path: about six empty „Kontoauszüge“ per account per day in
# the list the user and the Prüfer work through.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-677-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier990-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/fints/connections?companyId=$C" "{\"companyId\":\"$C\",\"blz\":\"12030000\",\"userId\":\"demo\",\"label\":\"Demo\",\"pin\":\"demo-pin-0\",\"mockMode\":true}"
CN=$(json_field "$BODY" id)
# spec 32 counts every active connection: this one goes at the end, whatever happens
trap 'curl -sS -o /dev/null -X DELETE "$API/api/v1/fints/connections/$CN?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"' EXIT
AS POST "/api/v1/fints/connections/$CN/sync?companyId=$C" "{\"companyId\":\"$C\"}"
RUN=$(json_field "$BODY" syncRunId); [[ -n "$RUN" ]] || RUN=$(json_field "$BODY" id)
AS POST "/api/v1/fints/sync-runs/$RUN/tan?companyId=$C" "{\"companyId\":\"$C\",\"tan\":\"123456\"}"
stmts() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "select count(*) from \"BankStatement\" where \"companyId\"='$C'"; }
assert_eq "fixture: the first sync — one statement" "$(stmts)" "1"
for i in 2 3 4; do AS POST "/api/v1/fints/connections/$CN/sync?companyId=$C" "{\"companyId\":\"$C\"}"; done
assert_eq "three syncs with nothing new: still one statement (was 4)" "$(stmts)" "1"

summary
