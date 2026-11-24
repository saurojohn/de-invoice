#!/bin/bash
# Tier 994 — the 10 000 € threshold of § 3c UStG is shown
#
# A company outside the OSS sold to a consumer in Paris for 5 000 € net three
# times in the year (19 %, German tax): 15 000 € — the OSS report said
# invoiceCount 0 / excludedGermanRate 3, no total, no threshold; the deadlines
# showed nothing. § 3c Abs. 4 UStG: German tax on such sales holds only while
# they stayed at or below 10 000 € in the previous year and have not passed it
# in this one (goods sent abroad and TBE services — whether the sales are
# such, the program does not know: it says so, it does not refuse).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-681-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
Y=${TODAY:0:4}; M=$((10#${TODAY:5:2})); Q=$(( (M - 1) / 3 + 1 ))

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier994-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company outside the OSS" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Jean\",\"type\":\"individual\",\"address\":{\"street\":\"1 rue\",\"city\":\"Paris\",\"postalCode\":\"75001\",\"country\":\"FR\"}}"
K=$(json_field "$BODY" id)
for n in 1 2 3; do
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware $n\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":5000,\"vatRate\":0.19}]}"
  AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
done
assert_eq "fixture: three sales of 5 000 € to a consumer in Paris, issued" "$STATUS" "200"
AS GET "/api/v1/reports/oss?companyId=$C&year=$Y&quarter=$Q"
assert_eq "the OSS report: the year's sales to consumers abroad, 15 000 € — above 10 000 € (was: no figure)" \
  "$(P "float((d.get('threshold') or {}).get('currentYear') or 0), (d.get('threshold') or {}).get('limit'), (d.get('threshold') or {}).get('exceeded')")" "(15000.0, 10000, True)"

summary
