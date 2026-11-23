#!/bin/bash
# Tier 964 — a customer-portal link: its lifetime, its address, its end
#
# Every portal request moved the link's end 30 days on (the mail promises 30
# days); the company changed the customer's contact (the bookkeeper left) and
# the old link still read the invoices and their PDFs, and rewrote the
# customer's master data — the address later invoices are written to; the
# company had no way to end it. Now: 30 days from the link, ended when the
# contact's address is no longer the one it was sent to, and a route to
# withdraw it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-651-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier964-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
OLD="$TAG-alt@example.test"; NEW="$TAG-neu@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde P\",\"type\":\"business\",\"contact\":{\"email\":\"$OLD\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
link() { AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
  echo "$BODY" | python3 -c "import sys,json,re;print(re.search(r'token=([0-9a-f]+)',json.load(sys.stdin)['url']).group(1))"; }
portal() { curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/customer-portal/invoices?token=$1"; }

T=$(link)
E0=$(sql "select \"expiresAt\" from \"CustomerPortalSession\" where \"customerId\" = '$K'")
sleep 1.2
assert_eq "the link works" "$(portal "$T")" "200"
assert_eq "…and keeps its end (was moved 30 days on with every use)" "$(sql "select \"expiresAt\" from \"CustomerPortalSession\" where \"customerId\" = '$K'")" "$E0"

AS PUT "/api/v1/customers/$K?companyId=$C" "{\"contact\":{\"email\":\"$NEW\"}}"
assert_eq "the company changes the contact's address" "$STATUS" "200"
assert_eq "…the old link ends (was 200)" "$(portal "$T")" "401"
R=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/v1/customer-portal/profile?token=$T" -H "Content-Type: application/json" \
  -d "{\"contact\":{\"email\":\"$OLD\"},\"address\":{\"street\":\"Neue Str. 1\"}}")
assert_eq "…and cannot rewrite the customer (was 200)" "$R/$(sql "select contact->>'email' from \"Customer\" where id = '$K'")" "401/$NEW"

T2=$(link)
assert_eq "a new link to the new address works" "$(portal "$T2")" "200"
R=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/v1/customer-portal/profile?token=$T2" -H "Content-Type: application/json" \
  -d "{\"contact\":{\"email\":\"$TAG-neu2@example.test\"}}")
assert_eq "…the customer changes its own address: its link moves with it" "$R/$(portal "$T2")" "200/200"
AS DELETE "/api/v1/customers/$K/portal-sessions?companyId=$C"
assert_eq "the company withdraws the access (no route before)" "$STATUS" "200"
assert_eq "…the link ends" "$(portal "$T2")" "401"

summary
