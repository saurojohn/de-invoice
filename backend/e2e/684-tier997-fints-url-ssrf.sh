#!/bin/bash
# Tier 997 — a FinTS address that resolves inside is refused
#
# The bank's FinTS URL was checked only by its text when the connection was
# saved (HTTPS, no private IP literal): a name that resolves to 127.0.0.1 or
# an address inside the network was saved, and the server posted the dialog
# (PIN, TAN) to it — following any redirect. The webhooks resolve the name and
# refuse private addresses since Tier 391 / 863; the FinTS address did not
# (SSRF, OWASP A10).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-684-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier997-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
CREATED=""
trap '[[ -n "$CREATED" ]] && curl -sS -o /dev/null -X DELETE "$API/api/v1/fints/connections/$CREATED?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"' EXIT
# nip.io answers *.<ip>.nip.io with <ip> — a DNS name that lands on 127.0.0.1 (as spec 50)
if python3 -c "import socket;socket.gethostbyname('127.0.0.1.nip.io')" 2>/dev/null; then
  AS POST "/api/v1/fints/connections?companyId=$C" "{\"companyId\":\"$C\",\"blz\":\"12030000\",\"userId\":\"demo\",\"label\":\"$TAG\",\"pin\":\"demo-pin-0\",\"mockMode\":true,\"endpointUrl\":\"https://127.0.0.1.nip.io/fints\"}"
  [[ "$STATUS" == 2* ]] && CREATED=$(json_field "$BODY" id)
  assert_eq "a FinTS URL whose name resolves to 127.0.0.1: refused (was 201)" "$STATUS/$(json_field "$BODY" message | grep -c 'private Adresse')" "400/1"
else
  note "127.0.0.1.nip.io does not resolve here — the DNS check is not exercised"
fi
AS POST "/api/v1/fints/connections?companyId=$C" "{\"companyId\":\"$C\",\"blz\":\"12030000\",\"userId\":\"demo\",\"label\":\"$TAG\",\"pin\":\"demo-pin-0\",\"mockMode\":true,\"endpointUrl\":\"https://10.0.0.1/fints\"}"
assert_eq "a private IP literal: refused, as before" "$STATUS" "400"

summary
