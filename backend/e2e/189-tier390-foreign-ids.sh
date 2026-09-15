#!/bin/bash
# Tier 390 — ids of other records in a request must be the company's own
#
# The UStVA page's "Eingangsrechnung erfassen" form only reached the backend
# once it sent the auth headers (Tier 390). Measured then:
#   supplierId ""                     → 500 (Expense_supplierId_fkey) — the form's empty select
#   company B with company A's supplier → 201, and the response carried A's supplier record
# Cash book entries (same kind of foreign key, found by a scan):
#   company B's entry with company A's invoiceId → 201
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-189-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
Q="companyId=$COMPANY_ID"

api_post "/api/v1/suppliers?$Q" "{\"name\":\"$TAG Lieferant\"}"
SUP=$(json_field "$BODY" id)
REG=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier390-e2e\",\"companyName\":\"$TAG other\"}")
read -r UB CB < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "$SUP" && -n "${CB:-}" ]] && pass "fixtures: a supplier of this company, another company" || { fail "fixtures"; summary; exit 1; }
expense() { # extra-json
  printf '{"description":"%s","invoiceDate":"2026-09-01","netAmount":100,"vatRate":0.19%s}' "$TAG" "$1"
}
EXPENSES() { sql "SELECT count(*) FROM \"Expense\" WHERE description = '$TAG';"; }

note "=== 1. the UStVA page's shapes ==="
api_post "/api/v1/ustva/expenses?$Q" "$(expense ',"invoiceNumber":"","supplierId":"","category":"","isIntraEU":false,"isReverseCharge":false')"
assert_status 201 "empty supplier select (was 500)"
assert_eq "…stored without a supplier" "$(sql "SELECT count(*) FROM \"Expense\" WHERE id = '$(json_field "$BODY" id)' AND \"supplierId\" IS NULL;")" "1"
api_post "/api/v1/ustva/expenses?$Q" "$(expense ",\"supplierId\":\"$SUP\"")"
assert_status 201 "own supplier"
assert_eq "…linked" "$(json_field "$BODY" supplier.id)" "$SUP"

note "=== 2. another company's supplier is refused ==="
BEFORE=$(EXPENSES)
RESP=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/ustva/expenses?companyId=$CB" -H "x-user-id: $UB" -H "x-company-id: $CB" \
  -H "Content-Type: application/json" -d "$(expense ",\"supplierId\":\"$SUP\"")")
STATUS=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_status 400 "company B with company A's supplier (was 201 with A's supplier record)"
[[ "$BODY" != *"$TAG Lieferant"* ]] && pass "…no supplier data in the answer" || fail "…answer contains A's supplier"
assert_eq "…no expense stored" "$(EXPENSES)" "$BEFORE"

note "=== 3. cash book entry links ==="
AS_B() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $UB" -H "x-company-id: $CB" -H "Content-Type: application/json" -d "$3")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
QB="companyId=$CB"
AS_B POST "/api/v1/customers?$QB" "{\"name\":\"$TAG B Kunde\",\"type\":\"business\"}"; B_CUST=$(json_field "$BODY" id)
AS_B POST "/api/v1/invoices?$QB" "{\"customerId\":\"$B_CUST\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"$TAG\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}"; B_INV=$(json_field "$BODY" id)
AS_B POST "/api/v1/cashbook/entries?$QB" '{"businessDate":"2026-09-01","type":"eroeffnung","description":"Eröffnung","amount":100}'
assert_status 201 "B: opening balance"
# the "other" company for the links: a third fresh company, so the shared seed company keeps no stray invoice
REG_C=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-c@example.test\",\"password\":\"Tier390-e2e\",\"companyName\":\"$TAG c\"}")
read -r UC CC < <(echo "$REG_C" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
C_CUST=$(curl -s -X POST "$API/api/v1/customers?companyId=$CC" -H "x-user-id: $UC" -H "x-company-id: $CC" -H "Content-Type: application/json" \
  -d "{\"name\":\"$TAG C Kunde\",\"type\":\"business\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null)
A_INV=$(curl -s -X POST "$API/api/v1/invoices?companyId=$CC" -H "x-user-id: $UC" -H "x-company-id: $CC" -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$C_CUST\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"$TAG C\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null)
[[ -n "$B_INV" && -n "$A_INV" ]] && pass "fixtures: an invoice in B and in a third company" || fail "invoice fixtures"
ENTRIES() { sql "SELECT count(*) FROM \"CashBookEntry\" WHERE \"companyId\" = '$CB';"; }
AS_B POST "/api/v1/cashbook/entries?$QB" "{\"businessDate\":\"2026-09-02\",\"type\":\"einnahme\",\"description\":\"$TAG own\",\"amount\":5,\"invoiceId\":\"$B_INV\"}"
assert_status 201 "B: entry linked to its own invoice"
BEFORE=$(ENTRIES)
AS_B POST "/api/v1/cashbook/entries?$QB" "{\"businessDate\":\"2026-09-02\",\"type\":\"einnahme\",\"description\":\"$TAG foreign\",\"amount\":5,\"invoiceId\":\"$A_INV\"}"
assert_status 400 "B: entry linked to another company's invoice (was 201)"
AS_B POST "/api/v1/cashbook/entries?$QB" "{\"businessDate\":\"2026-09-02\",\"type\":\"ausgabe\",\"description\":\"$TAG foreign exp\",\"amount\":5,\"expenseId\":\"00000000-0000-0000-0000-000000000000\"}"
assert_status 400 "B: entry linked to an unknown expense"
assert_eq "…no entry stored" "$(ENTRIES)" "$BEFORE"

note "=== 4. cleanup ==="
for id in $(sql "SELECT id FROM \"Expense\" WHERE description = '$TAG' AND \"companyId\" = '$COMPANY_ID';"); do
  api_delete "/api/v1/ustva/expenses/$id?$Q"
done
assert_eq "expenses removed" "$(EXPENSES)" "0"

summary
exit $?
