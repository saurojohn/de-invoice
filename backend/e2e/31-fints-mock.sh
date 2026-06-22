#!/bin/bash
# Test 31: Tier 6 — FinTS bank connection (mock mode)
#
# Covers the read-only path end to end:
#   1. Create a FinTSConnection (mock mode)
#   2. List connections — see the new row
#   3. Start sync — first time returns needs_tan
#   4. Submit a 6-digit TAN — completes the sync
#   5. Verify 3 mock transactions were persisted
#   6. Re-sync the same connection — should be
#      idempotent (no duplicate transactions)
#   7. Auto-match against an open invoice with
#      a matching amount + invoice number
#   8. Verify a BankReconciliation row was
#      created with confidence 100
#   9. Delete the connection — BankStatement +
#      BankTransaction stay (audit trail)
#  10. List sync-runs — see the history

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 6 FinTS (mock mode) ==="

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ----- Clean prior state -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';
  DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID' AND format = 'fints-mock';
  DELETE FROM \"FinTSSyncRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"FinTSConnection\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

# ----- 1. Create connection -----
api_post "/api/v1/fints/connections" "{\"companyId\":\"$COMPANY_ID\",\"blz\":\"50050201\",\"userId\":\"e2e-test-user\",\"label\":\"E2E Sparkasse\",\"pin\":\"12345\",\"mockMode\":true}"
CONN_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
assert_status 201 "1. Create FinTS connection (201)"

if [[ -n "$CONN_ID" ]]; then
  pass "1. connection id = $CONN_ID"
else
  fail "1. connection id is empty"
  echo "$BODY"
  exit 1
fi

# ----- 2. List connections -----
api_get "/api/v1/fints/connections?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "2. List shows 1 connection" "$COUNT" "1"

# ----- 3. Start sync (first time → needs_tan) -----
api_post "/api/v1/fints/connections/$CONN_ID/sync" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "3a. Start sync (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "3b. First sync needs_tan" "$STATUS" "needs_tan"
SYNC_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['syncRunId'])")
TAN_CHAL=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['tanChallenge'])")
if [[ -n "$TAN_CHAL" && "$TAN_CHAL" != *"null"* ]]; then
  pass "3c. TAN challenge is non-empty"
else
  fail "3c. TAN challenge is empty: $TAN_CHAL"
fi

# ----- 4. Submit TAN -----
api_post "/api/v1/fints/sync-runs/$SYNC_ID/tan" "{\"companyId\":\"$COMPANY_ID\",\"tan\":\"123456\"}"
assert_status 201 "4a. Submit TAN (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "4b. Sync completed" "$STATUS" "ok"
TX_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['txCount'])")
assert_eq "4c. 3 transactions fetched" "$TX_COUNT" "3"

# ----- 5. Verify transactions in DB -----
DB_TX_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankTransaction\" 
  WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';" 2>/dev/null | tr -d ' ')
assert_eq "5. 3 mock transactions in DB" "$DB_TX_COUNT" "3"

# ----- 6. Re-sync — should be idempotent -----
# After the first sync, the connection's
# systemId is set, so subsequent syncs skip
# the TAN. But the same 3 transactions
# should NOT be duplicated.
api_post "/api/v1/fints/connections/$CONN_ID/sync" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "6a. Re-sync (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
# After first sync, systemId is set, so this
# should be 'ok' (no TAN).
assert_eq "6b. Second sync is ok (systemId cached)" "$STATUS" "ok"
TX_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['txCount'])")
# txCount is the number of NEW transactions
# inserted, which should be 0 (all duplicates).
assert_eq "6c. No new transactions on re-sync" "$TX_COUNT" "0"
DB_TX_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankTransaction\" 
  WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';" 2>/dev/null | tr -d ' ')
assert_eq "6d. Still 3 transactions in DB (idempotent)" "$DB_TX_COUNT" "3"

# ----- 7. Auto-match -----
# Seed an open invoice that matches the
# Müller GmbH transaction exactly (2380.00 EUR
# and invoice number "E2E-T6-001" in the
# purpose string).
CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')

# Add the invoice's "001" in the customer
# number to help IBAN-based matching on a
# later test (not needed here, just data).
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceNumber\",
    type, status, \"issueDate\", \"dueDate\",
    subtotal, \"totalVat\", total, currency, language, \"vatBreakdown\",
    \"reverseCharge\", \"euTransaction\", notes, \"templateType\", \"pdfPath\", attachments, \"createdAt\", \"updatedAt\")
  VALUES ('e2e00006-0001-0000-0000-000000000001', '$COMPANY_ID', '$CUST_ID', 'E2E-T6-001', 9901,
   'INV', 'sent', '2026-06-01', '2026-07-01', 2000.00, 380.00, 2380.00, 'EUR', 'de-DE',
   '[{\"rate\":0.19}]'::jsonb, false, false, 'T6 e2e', 'standard', NULL, '[]', now(), now())
  ON CONFLICT DO NOTHING;" >/dev/null 2>&1

api_post "/api/v1/fints/auto-match" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "7a. Auto-match (201)"
MATCHED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['matched'])")
SUGGESTED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['suggested'])")
# 2,380 matches the Müller invoice → confidence 100
# (purpose has "E2E-T6-001")
if [[ "$MATCHED" -ge 1 ]]; then
  pass "7b. at least 1 high-confidence match"
else
  fail "7b. expected ≥1 match, got $MATCHED"
fi

# ----- 8. Verify BankReconciliation row -----
RECON_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankReconciliation\" 
  WHERE \"companyId\" = '$COMPANY_ID' AND status = 'suggested';" 2>/dev/null | tr -d ' ')
if [[ "$RECON_COUNT" -ge 1 ]]; then
  pass "8. BankReconciliation row created"
else
  fail "8. no BankReconciliation row"
fi

RECON_CONF=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT confidence FROM \"BankReconciliation\" 
  WHERE \"companyId\" = '$COMPANY_ID' 
  AND \"invoiceId\" = 'e2e00006-0001-0000-0000-000000000001' 
  LIMIT 1;" 2>/dev/null | tr -d ' ')
assert_eq "8b. confidence = 100 (amount + invoice# in purpose)" "$RECON_CONF" "100"

# ----- 9. List sync-runs -----
api_get "/api/v1/fints/connections/$CONN_ID/sync-runs?companyId=$COMPANY_ID"
RUNS_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
if [[ "$RUNS_COUNT" -ge 2 ]]; then
  pass "9. Sync-runs history shows ≥2 entries"
else
  fail "9. expected ≥2 sync-runs, got $RUNS_COUNT"
fi

# ----- 10. Delete connection -----
api_delete "/api/v1/fints/connections/$CONN_ID?companyId=$COMPANY_ID"
assert_status 200 "10a. Delete connection (200)"

# Verify connection gone
api_get "/api/v1/fints/connections?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "10b. List is empty after delete" "$COUNT" "0"

# But BankTransaction + Reconciliation stay
# (audit trail — GoBD §146 requires we
# never lose the original parsed data).
DB_TX_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankTransaction\" 
  WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';" 2>/dev/null | tr -d ' ')
assert_eq "10c. BankTransactions kept after FinTS delete (audit trail)" "$DB_TX_COUNT" "3"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';
  DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID' AND format = 'fints-mock';
  DELETE FROM \"FinTSSyncRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"Invoice\" WHERE id = 'e2e00006-0001-0000-0000-000000000001';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
