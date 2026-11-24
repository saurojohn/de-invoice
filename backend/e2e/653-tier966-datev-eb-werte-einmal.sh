#!/bin/bash
# Tier 966 — the DATEV opening balances open one fiscal year
#
# The opening balances (EB-Werte on 9000) entered once went into every
# export: each later year's again (DATEV's Jahresübernahme brings that year's
# own — the adviser's SuSa had the Kasse twice), and into an April batch with
# a row of 1 January, outside the batch's period.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-653-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier966-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-03-10\",\"deliveryDate\":\"2025-03-10\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"openingBalances":[{"konto":"1000","betrag":5000,"shVz":"S","buchungstext":"EB Kasse"}]}'
assert_eq "opening balance Kasse 5 000 € (the books start in 2025)" "$STATUS" "200"
eb() { curl -sS -o "$W/x.csv" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$1&endDate=$2"
  datev_rows "$W/x.csv" | awk -F'\t' '$1 ~ /^EB-/' | wc -l | tr -d ' '; }
assert_eq "the 2025 export carries it" "$(eb 2025-01-01 2025-12-31)" "1"
assert_eq "the 2026 export does not (was the same row again)" "$(eb 2026-01-01 2026-12-31)" "0"
assert_eq "nor an April batch (was a row of 1 January in it)" "$(eb 2025-04-01 2025-04-30)" "0"

summary
