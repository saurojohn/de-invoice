#!/bin/bash
# Tier 970 — what a tax auditor's read makes the system write
#
# A tax auditor (Prüferzugang) writes nothing. His GET of the DATEV export
# gave a customer its DATEV Personenkonto (the system assigns it on the first
# export) — and the audit trail named the auditor as the author of
# customer.updated (§ 147 Abs. 6 AO: his access is read-only).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-657-$(date +%s%N | cut -c1-13)"
UNTIL=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier970-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # user method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS "$U" POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS "$U" POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-03-10\",\"deliveryDate\":\"2026-03-10\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS "$U" PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS "$U" POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-p@example.test\",\"role\":\"auditor\",\"accessUntil\":\"$UNTIL\"}"
A=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" \
  -d "{\"token\":\"$(invite_token "$TAG-p@example.test")\",\"password\":\"Tier970-pruef\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))")
[[ -n "$A" ]] && pass "fixture: a tax auditor" || fail "auditor"

AS "$A" GET "/api/v1/reports/datev-export?companyId=$C&startDate=2026-01-01&endDate=2026-12-31"
assert_eq "the auditor reads the DATEV export" "$STATUS" "200"
assert_eq "…the customer got its Personenkonto (the system's step)" "$(sql "select \"datevAccount\" is not null from \"Customer\" where id = '$K'")" "t"
assert_eq "…and the audit trail names no auditor as its author (was the auditor)" \
  "$(sql "select count(*) from \"AuditLog\" where \"companyId\" = '$C' and \"userId\" = '$A' and action like '%.updated'")" "0"

summary
