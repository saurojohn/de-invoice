#!/bin/bash
# Tier 551 — a request without ?companyId= is not a request for every company
#
# Prisma drops an undefined filter: `where: { companyId: undefined }` selects
# every row. The auth guard compares a companyId that is in the request; it
# said nothing about one that is missing. Measured as the admin of a company
# registered a minute before, leaving the parameter out:
#   GET /invoices            → 200, every company's invoices
#   GET /webhooks            → 200, every company's webhooks (name, url)
#   GET /reports/sales       → 200, every company's customers and revenue
#   GET /reports/customers   → 200, the same
#   GET /reminders/overdue   → 200, every company's overdue invoices
# Now a where clause that names companyId without a value is refused for
# every model and operation (prisma/company-scope.extension.ts) → 400.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-336-$(date +%s%N | cut -c1-13)"
tenant() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier551-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA CA < <(tenant a); read -r UB CB < <(tenant b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
fixture_issuer "$CA"
a() { curl -sS -m 30 -X "$1" "$API$2" -H "x-user-id: $UA" -H "x-company-id: $CA" -H "Content-Type: application/json" ${3:+-d "$3"}; }
b() { curl -s -o /tmp/t551.out -w '%{http_code}' -m 60 "$API$1" -H "x-user-id: $UB" -H "x-company-id: $CB"; }
R=$(a POST "/api/v1/customers?companyId=$CA" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"); K=$(json_field "$R" id)
R=$(a POST "/api/v1/invoices?companyId=$CA" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"); I=$(json_field "$R" id)
a PUT "/api/v1/invoices/$I/status?companyId=$CA" '{"status":"sent"}' >/dev/null
R=$(a POST "/api/v1/webhooks?companyId=$CA" "{\"url\":\"https://example.org/h\",\"events\":[\"invoice.paid\"],\"name\":\"$TAG hook\"}"); W=$(json_field "$R" id)
[[ -n "$I" && -n "$W" ]] && pass "fixture: company A has an issued invoice and a webhook" || fail "fixture: inv=$I hook=$W"
leaks() { grep -c "$CA\|$I\|$K\|$TAG a\|$TAG hook\|$TAG Kunde" /tmp/t551.out; }

note "=== B asks without companyId ==="
for p in /invoices /webhooks /reports/sales /reports/customers /reminders/overdue; do
  assert_eq "GET $p: 400 (was 200 with every company's rows)" "$(b "/api/v1$p")" "400"
  assert_eq "…nothing of A in the answer" "$(leaks)" "0"
done
assert_eq "…the message names the parameter" "$(grep -c "companyId" /tmp/t551.out)" "1"

note "=== B asks for its own company ==="
for p in /invoices /webhooks /reports/sales /reports/customers /reminders/overdue; do
  assert_eq "GET $p?companyId=<own>: 200" "$(b "/api/v1$p?companyId=$CB")" "200"
  assert_eq "…nothing of A in the answer" "$(leaks)" "0"
done
assert_eq "A still sees its invoice" "$(a GET "/api/v1/invoices?companyId=$CA" | grep -c "$I")" "1"
rm -f /tmp/t551.out
summary
