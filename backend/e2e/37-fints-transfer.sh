#!/bin/bash
# Tier 10: SEPA-Überweisung + Lastschrift via FinTS
# (HKCSE + HKCCS). 2-step TAN flow (start →
# needs_tan → submit → ok).
#
# Coverage:
#   1.  Create a mock FinTS connection
#       (required for transfers).
#   2.  POST /fints/transfers with a valid
#       IBAN → 201, status='needs_tan',
#       tanChallenge populated.
#   3.  POST same endToEndId again →
#       idempotency: returns the SAME
#       transferId, status still
#       'needs_tan'.
#   4.  POST a 5-character TAN → status
#       'failed' (TAN too short).
#   5.  POST a valid 6-digit TAN → status
#       'ok', transfer row updated to
#       finishedAt != null.
#   6.  GET /fints/transfers lists the
#       history with the new row.
#   7.  POST a credit transfer with an
#       INVALID IBAN (MOD-97 fail) → 500
#       with 'creditorIban ist ungültig'.
#   8.  POST a credit transfer with
#       amount=0 → 500 with 'amount muss
#       > 0'.
#   9.  POST a Lastschrift (direct_debit)
#       without mandateId → 500 with
#       'mandateId ist für Lastschrift
#       erforderlich'.
#   10. POST a Lastschrift WITH
#       mandateId + sequenceType →
#       needs_tan.
#   11. Submit TAN for the Lastschrift →
#       status='ok'.
#   12. Try to submit TAN on a transfer
#       that's already 'ok' → 500 with
#       'needs_tan-Status'.
#   13. End-to-End-Id > 35 chars → 500
#       'endToEndId ist erforderlich'.
#   14. List filtered by status='ok'
#       returns 2 rows.
#   15. List filtered by status='failed'
#       returns the bad-TAN row from #4.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 10 SEPA Transfer via FinTS ==="
# Clean leftover FinTsTransfer / FinTSConnection
cat > /tmp/t37_cleanup.sql << EOF
DELETE FROM "FinTsTransfer" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSConnection" WHERE "companyId" = '${COMPANY_ID}' AND label = 'T10-Test';
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t37_cleanup.sql >/dev/null 2>&1

# ===== 1. Create mock FinTS connection =====
api_post "/api/v1/fints/connections" '{"companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test","label":"T10-Test","pin":"12345","mockMode":true}'
assert_status 201 "1. create mock FinTS connection (201)"
CONN_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
note "Connection ID: $CONN_ID"

# ===== 2. POST transfer with valid IBAN → needs_tan =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"credit_transfer",
  "creditorName":"Max Mustermann",
  "creditorIban":"DE89370400440532013000",
  "amount":"119.00",
  "purpose":"Rechnung R-2026-001",
  "endToEndId":"E2E-T10-CT-001"
}'
assert_status 201 "2. create credit_transfer (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "2b. status=needs_tan" "$STATUS" "needs_tan"
CHALLENGE=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tanChallenge',''))")
[[ -n "$CHALLENGE" ]] && note "Challenge: $CHALLENGE" || note "no challenge"
TRANSFER_ID_1=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['transferId'])")
note "Transfer ID 1: $TRANSFER_ID_1"

# ===== 3. Idempotency: same endToEndId returns SAME row =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"credit_transfer",
  "creditorName":"Max Mustermann",
  "creditorIban":"DE89370400440532013000",
  "amount":"119.00",
  "endToEndId":"E2E-T10-CT-001"
}'
assert_status 201 "3. idempotent POST (201)"
TRANSFER_ID_1B=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['transferId'])")
assert_eq "3b. same transferId on idempotent retry" "$TRANSFER_ID_1B" "$TRANSFER_ID_1"

# ===== 4. Submit short TAN → failed =====
api_post "/api/v1/fints/transfers/$TRANSFER_ID_1/tan" '{"companyId":"'$COMPANY_ID'","tan":"12345"}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "4. 5-digit TAN → status=failed" "$STATUS" "failed"

# Row in DB still needs_tan (failed-TAN doesn't flip the status)
DB_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT status FROM \"FinTsTransfer\" WHERE id = '$TRANSFER_ID_1';" 2>/dev/null | tr -d ' ')
assert_eq "4b. DB status stays needs_tan after bad TAN" "$DB_STATUS" "needs_tan"

# ===== 5. Submit valid 6-digit TAN → ok =====
api_post "/api/v1/fints/transfers/$TRANSFER_ID_1/tan" '{"companyId":"'$COMPANY_ID'","tan":"123456"}'
assert_status 201 "5. valid TAN submit (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "5b. status=ok" "$STATUS" "ok"

FINISHED=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT (\"finishedAt\" IS NOT NULL)::text FROM \"FinTsTransfer\" WHERE id = '$TRANSFER_ID_1';" 2>/dev/null | tr -d ' ')
assert_eq "5c. finishedAt is set in DB" "$FINISHED" "true"

# ===== 6. List transfers shows both =====
api_get "/api/v1/fints/transfers?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "6. list transfers shows 1 row" "$COUNT" "1"

# ===== 7. Invalid IBAN (MOD-97 fail) =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"credit_transfer",
  "creditorName":"X",
  "creditorIban":"DE00000000000000000001",
  "amount":"10.00",
  "endToEndId":"E2E-T10-BAD-IBAN"
}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")
assert_eq "7. invalid IBAN → 400" "$STATUS" "400"

# ===== 8. amount=0 =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"credit_transfer",
  "creditorName":"X",
  "creditorIban":"DE89370400440532013000",
  "amount":"0.00",
  "endToEndId":"E2E-T10-ZERO"
}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")
assert_eq "8. amount=0 → 400" "$STATUS" "400"

# ===== 9. Lastschrift without mandateId =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"direct_debit",
  "creditorName":"Hans Schmidt",
  "creditorIban":"DE89370400440532013000",
  "amount":"50.00",
  "endToEndId":"E2E-T10-DD-NOMANDATE"
}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")
assert_eq "9. Lastschrift without mandate → 400" "$STATUS" "400"

# ===== 10. Lastschrift with mandate → needs_tan =====
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"direct_debit",
  "creditorName":"Hans Schmidt",
  "creditorIban":"DE89370400440532013000",
  "amount":"50.00",
  "endToEndId":"E2E-T10-DD-001",
  "mandateId":"M-2026-001",
  "sequenceType":"FRST"
}'
assert_status 201 "10. Lastschrift with mandate (201)"
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "10b. status=needs_tan" "$STATUS" "needs_tan"
TRANSFER_ID_2=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['transferId'])")

# ===== 11. Submit TAN for Lastschrift → ok =====
api_post "/api/v1/fints/transfers/$TRANSFER_ID_2/tan" '{"companyId":"'$COMPANY_ID'","tan":"654321"}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
assert_eq "11. Lastschrift TAN → ok" "$STATUS" "ok"

# ===== 12. Re-submit TAN on already-ok transfer → 400 =====
api_post "/api/v1/fints/transfers/$TRANSFER_ID_2/tan" '{"companyId":"'$COMPANY_ID'","tan":"111111"}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")
assert_eq "12. double TAN submit → 400" "$STATUS" "400"

# ===== 13. endToEndId > 35 chars → 400 =====
LONG_ID="E2E-T10-LONG-XXXXXXXXXXXXXXXXXXXXXXXX"  # 38 chars (over SEPA 35-char limit)
api_post "/api/v1/fints/transfers" '{
  "companyId":"'$COMPANY_ID'",
  "connectionId":"'$CONN_ID'",
  "kind":"credit_transfer",
  "creditorName":"X",
  "creditorIban":"DE89370400440532013000",
  "amount":"5.00",
  "endToEndId":"'$LONG_ID'"
}'
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")
assert_eq "13. endToEndId > 35 chars → 400" "$STATUS" "400"

# ===== 14. status=ok filter =====
api_get "/api/v1/fints/transfers?companyId=$COMPANY_ID&status=ok"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "14. status=ok returns 2 rows (Überweisung + Lastschrift)" "$COUNT" "2"

# ===== 15. status=needs_tan filter =====
api_get "/api/v1/fints/transfers?companyId=$COMPANY_ID&status=needs_tan"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "15. status=needs_tan returns 0 rows (TAN'd in)" "$COUNT" "0"

# ===== 16. status filter by connectionId =====
api_get "/api/v1/fints/transfers?companyId=$COMPANY_ID&connectionId=$CONN_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "16. connectionId filter returns 2 rows" "$COUNT" "2"

# ----- Cleanup -----
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t37_cleanup.sql >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary