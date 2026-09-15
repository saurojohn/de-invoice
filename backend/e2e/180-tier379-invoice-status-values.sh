#!/bin/bash
# Tier 379 — PUT /invoices/:id/status only accepts the known statuses
#
# The handler stored whatever `status` it was given. Measured before the
# change: {"status":"lolwut"} → 200 and "lolwut" persisted; {} → 200 and
# nothing changed. The accepted values are the ones the invoice detail page's
# status dropdown offers (draft, sent, paid, overdue, cancelled) — the only UI
# caller — and the ones the backend writes itself.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }
CUST=$(sql "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' ORDER BY \"createdAt\" LIMIT 1;")
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "{\"customerId\":\"$CUST\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"e2e-180\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}"
assert_status 201 "fixture invoice"
INV=$(json_field "$BODY" id)
S="/api/v1/invoices/$INV/status?companyId=$COMPANY_ID"
db_status() { sql "SELECT status FROM \"Invoice\" WHERE id = '$INV';"; }

note "=== 1. every value of the detail page's dropdown still works ==="
for st in sent overdue paid cancelled draft; do
  api_put "$S" "{\"status\":\"$st\"}"
  assert_status 200 "status → $st"
  assert_eq "stored status" "$(db_status)" "$st"
done

note "=== 2. anything else is 400 and changes nothing ==="
api_put "$S" '{"status":"lolwut"}';               assert_status 400 "unknown status (was 200 and stored)"
echo "$BODY" | grep -q "draft, sent, paid, overdue, cancelled" && pass "…message lists the allowed values" || fail "message: $BODY"
api_put "$S" '{}';                                assert_status 400 "missing status (was 200, no-op)"
api_put "$S" '{"status":1}';                      assert_status 400 "numeric status"
api_put "$S" '{"status":"PAID"}';                 assert_status 400 "wrong case"
api_put "$S" '{"status":"sent","note":"x"}';      assert_status 400 "undeclared field"
assert_eq "status unchanged after the rejected requests" "$(db_status)" "draft"

summary
exit $?
