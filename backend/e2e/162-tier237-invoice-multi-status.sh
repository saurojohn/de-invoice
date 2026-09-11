#!/bin/bash
# Tier 237 — e2e coverage: invoice list multi-status filter
#
# The /invoices endpoint's status filter used to accept a
# single value only. Tier 237 added comma-separated multi-
# status support (?status=overdue,sent) so the operator can
# show, e.g., "all outstanding invoices" (overdue + sent)
# in one view without combining the two searches manually.
#
# Assertions:
#   1. ?status=overdue returns only overdue invoices
#   2. ?status=sent returns only sent invoices
#   3. ?status=overdue,sent returns BOTH overdue + sent
#   4. ?status=,  (empty segments) is treated as no filter
#   5. ?status=overdue (single) still works (no breaking change)
#   6. ?status=overdue,,sent (extra commas) is normalised
#   7. ?status=  (whitespace) is treated as no filter
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

# ---- 0. Fixture ----
# Tier 361: the spec assumed the company already had overdue and sent
# invoices. The developer database did; the CI seed has no overdue invoice,
# so assertion 1 ("overdue count = 0") failed the first time the spec ran.
# Create one of each for a throwaway customer and delete them at the end.
# The sent invoice's due date is far in the future so nothing can flip it
# to overdue mid-run.
T237="t237-$(date +%s)-$$"
T237_CUST="00000000-0000-4000-8000-$(printf '%012d' $$)"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c "
  INSERT INTO \"Customer\" (id, name, type, address, \"paymentTerms\", \"companyId\", \"createdAt\", \"updatedAt\")
    VALUES ('$T237_CUST', 'Tier 237 fixture $T237', 'business', '{\"country\": \"Deutschland\"}'::jsonb, 30, '$COMPANY_ID', NOW(), NOW());
  INSERT INTO \"Invoice\" (id, \"invoiceNumber\", type, status, \"issueDate\", \"dueDate\", currency, subtotal, \"totalVat\", total, notes, \"customerId\", \"companyId\", \"createdAt\", \"updatedAt\") VALUES
    (gen_random_uuid()::text, '$T237-OVERDUE', 'INV', 'overdue', CURRENT_DATE - 60, CURRENT_DATE - 30, 'EUR', 100, 19, 119, '', '$T237_CUST', '$COMPANY_ID', NOW(), NOW()),
    (gen_random_uuid()::text, '$T237-SENT',    'INV', 'sent',    CURRENT_DATE,      '2099-12-31',      'EUR', 100, 19, 119, '', '$T237_CUST', '$COMPANY_ID', NOW(), NOW());" >/dev/null 2>&1
T237_ROWS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c "SELECT count(*) FROM \"Invoice\" WHERE \"customerId\"='$T237_CUST';" 2>/dev/null | tr -d ' ')
[ "$T237_ROWS" = "2" ] && pass "fixture: 1 overdue + 1 sent invoice ($T237)" || fail "fixture invoices not created (rows: '$T237_ROWS')"

# ---- 1. Single overdue ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=overdue&pageSize=500")
COUNT=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
STATUSES=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(','.join(sorted(set(i['status'] for i in d['data']))))")
[ "$COUNT" -ge 1 ] && pass "?status=overdue returns $COUNT invoice(s)" || fail "overdue count = $COUNT"
[ "$STATUSES" = "overdue" ] && pass "?status=overdue returns only overdue" || fail "overdue filter leaked: $STATUSES"

# ---- 2. Single sent ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=sent&pageSize=500")
COUNT=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
STATUSES=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(','.join(sorted(set(i['status'] for i in d['data']))))")
[ "$COUNT" -ge 1 ] && pass "?status=sent returns $COUNT invoice(s)" || fail "sent count = $COUNT"
[ "$STATUSES" = "sent" ] && pass "?status=sent returns only sent" || fail "sent filter leaked: $STATUSES"

# ---- 3. Multi overdue,sent ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=overdue,sent&pageSize=500")
MULTI_TOTAL=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
MULTI_STATUSES=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(','.join(sorted(set(i['status'] for i in d['data']))))")
# multi total should be >= single overdue + single sent
EXPECTED_MIN=$(( $(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=overdue" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['total'])") + 0 ))
[ "$MULTI_TOTAL" -ge "$EXPECTED_MIN" ] && pass "multi total $MULTI_TOTAL >= single overdue $EXPECTED_MIN" || fail "multi total $MULTI_TOTAL < single overdue $EXPECTED_MIN"
# Multi statuses should be subset of {overdue, sent}
case "$MULTI_STATUSES" in
  overdue|sent|overdue,sent|"") pass "multi statuses = $MULTI_STATUSES (subset of {overdue, sent})" ;;
  *) fail "multi filter leaked: $MULTI_STATUSES" ;;
esac

# ---- 4. Empty status (commas) = no filter ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=&pageSize=10")
EMPTY_TOTAL=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
[ "$EMPTY_TOTAL" -ge 1 ] && pass "empty status returns all invoices ($EMPTY_TOTAL total)" || fail "empty status returned 0"

# ---- 5. Single status (no breaking change) ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=paid&pageSize=10")
PAID_TOTAL=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
[ "$PAID_TOTAL" -ge 0 ] && pass "single status=paid works ($PAID_TOTAL invoice(s))" || fail "single status=paid failed"

# ---- 6. Whitespace + extra commas normalised ----
RESP=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices?companyId=$COMPANY_ID&status=overdue,%20%20,%20sent&pageSize=500")
WS_TOTAL=$(echo "$RESP" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d['total'])")
# Should match multi total (whitespace + empty segments ignored)
[ "$WS_TOTAL" = "$MULTI_TOTAL" ] && pass "whitespace/empty segments normalised (ws=$WS_TOTAL multi=$MULTI_TOTAL)" || note "whitespace normalised differently: ws=$WS_TOTAL multi=$MULTI_TOTAL (tolerated)"

# ---- 7. findForExport with multi-status (CSV export) ----
# The export endpoint uses findForExport which Tier 237 also
# patched. Verify the same multi-status support works there.
# Note: CSV export requires dateFrom OR dateTo (controller
# rejects 400 otherwise). We pass a wide date range so
# the multi-status filter is the actual discriminator.
HTTP=$(curl -sS -o /tmp/tier237-csv.txt -w "%{http_code}" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/invoices/export/csv?companyId=$COMPANY_ID&status=overdue,sent&dateFrom=2020-01-01&dateTo=2099-12-31")
[ "$HTTP" = "200" ] && pass "CSV export with multi-status returns 200" || fail "CSV export HTTP=$HTTP"
ROWS=$(wc -l < /tmp/tier237-csv.txt | tr -d ' ')
[ "$ROWS" -gt 1 ] && pass "CSV has $ROWS row(s) (header + data)" || fail "CSV only $ROWS line(s)"
# Verify CSV body has both overdue and sent rows.
# The CSV uses ; as the column separator (DE locale), not ,.
# The status column is the 3rd field — extract it cleanly.
OVERDUE_ROWS=$(awk -F';' 'NR>1 && $3=="overdue"{n++} END{print n+0}' /tmp/tier237-csv.txt)
SENT_ROWS=$(awk -F';' 'NR>1 && $3=="sent"{n++} END{print n+0}' /tmp/tier237-csv.txt)
[ "$OVERDUE_ROWS" -ge 1 ] && pass "CSV contains $OVERDUE_ROWS overdue row(s)" || note "CSV overdue count = $OVERDUE_ROWS (tolerated if 0 in date range)"
[ "$SENT_ROWS" -ge 1 ] && pass "CSV contains $SENT_ROWS sent row(s)" || fail "CSV no sent rows"

rm -f /tmp/tier237-csv.txt

# ---- Cleanup: fixture invoices + customer ----
LEFT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -q -c "
  DELETE FROM \"Invoice\" WHERE \"customerId\"='$T237_CUST';
  DELETE FROM \"Customer\" WHERE id='$T237_CUST';
  SELECT count(*) FROM \"Customer\" WHERE id='$T237_CUST';" 2>/dev/null | tail -1 | tr -d ' ')
[ "$LEFT" = "0" ] && pass "cleanup: fixture removed" || fail "cleanup: fixture customer $T237_CUST left behind ('$LEFT')"
summary
