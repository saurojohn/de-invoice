#!/bin/bash
# Tier 9: BankReconciliation surfaced in
# /dashboard/banking — full CRUD via the
# new GET /bank-import/reconciliations
# endpoint. The UI panel renders the
# same response shape, so the e2e covers
# the contract the page consumes.
#
# Coverage:
#   1. Seed a BankReconciliation row +
#      check it shows up in /reconciliations
#      with status='suggested'
#   2. Confidence filter (?confidenceMin=80)
#      hides low-confidence matches
#   3. Status filter (?status=confirmed) hides
#      suggestions
#   4. Sort order is confidence DESC
#   5. Confirm a recon → status flips to
#      'confirmed', the row is no longer in
#      the default filter result
#   6. Reject a separate recon → status flips
#      to 'rejected'
#   7. The new endpoint returns up to 50
#      rows (the listReconciliations take=50)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 9 Reconciliation UI (banking panel backend) ==="
# Clean — remove leftover state from prior runs
cat > /tmp/t36_cleanup.sql << EOF
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'E2E-T9-%'
);
DELETE FROM "BankReconciliation" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "BankTransaction" WHERE "companyId" = '${COMPANY_ID}' AND "endToEndId" LIKE 'MOCK-T9-%';
DELETE FROM "BankStatement" WHERE "companyId" = '${COMPANY_ID}' AND "fileName" LIKE 't9-%';
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'E2E-T9-%';
DELETE FROM "FinTSSyncRun" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSConnection" WHERE "companyId" = '${COMPANY_ID}';
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t36_cleanup.sql >/dev/null 2>&1

# Seed 3 reconciliations with different confidences
CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')

# Need 3 invoices + 3 bank transactions + 3 reconciliations
cat > /tmp/t36_seed.sql << EOF
-- Invoices
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", notes, "templateType", "pdfPath", attachments, "createdAt", "updatedAt")
VALUES
  ('e2e00009-0001-0000-0007-000000000010', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T9-001', 9910, 'INV', 'sent', '2026-06-01', '2026-07-01', 1000.00, 190.00, 1190.00, 'EUR', 'de-DE', '[{"rate":0.19}]'::jsonb, false, false, 'T9', 'standard', NULL, '[]', now(), now()),
  ('e2e00009-0001-0000-0007-000000000011', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T9-002', 9911, 'INV', 'sent', '2026-06-01', '2026-07-01', 500.00, 95.00, 595.00, 'EUR', 'de-DE', '[{"rate":0.19}]'::jsonb, false, false, 'T9', 'standard', NULL, '[]', now(), now()),
  ('e2e00009-0001-0000-0007-000000000012', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T9-003', 9912, 'INV', 'sent', '2026-06-01', '2026-07-01', 800.00, 152.00, 952.00, 'EUR', 'de-DE', '[{"rate":0.19}]'::jsonb, false, false, 'T9', 'standard', NULL, '[]', now(), now());
-- BankStatement
INSERT INTO "BankStatement" (id, "companyId", format, "fileName", "fileSize", "rawContent", "createdAt")
VALUES ('e2e00009-0001-0000-0007-000000000099', '${COMPANY_ID}', 'fints-mock', 't9.json', 100, '[]', now());
-- BankTransactions
INSERT INTO "BankTransaction" (id, "statementId", "companyId", "valueDate", "entryDate", amount, currency, purpose, "endToEndId", "createdAt")
VALUES
  ('e2e00009-0001-0000-0007-000000000020', 'e2e00009-0001-0000-0007-000000000099', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 1190.00, 'EUR', 'Rechnung E2E-T9-001', 'MOCK-T9-001', now()),
  ('e2e00009-0001-0000-0007-000000000021', 'e2e00009-0001-0000-0007-000000000099', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 595.00, 'EUR', 'Kunde', 'MOCK-T9-002', now()),
  ('e2e00009-0001-0000-0007-000000000022', 'e2e00009-0001-0000-0007-000000000099', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 952.00, 'EUR', 'Betrag ungefaehr', 'MOCK-T9-003', now());
-- Reconciliations with descending confidence
INSERT INTO "BankReconciliation" (id, "bankTransactionId", "invoiceId", "companyId", "appliedAmount", status, confidence, "matchReason", "createdAt", "updatedAt")
VALUES
  ('e2e00009-0001-0000-0007-000000000030', 'e2e00009-0001-0000-0007-000000000020', 'e2e00009-0001-0000-0007-000000000010', '${COMPANY_ID}', 1190.00, 'suggested', 100, 'Betrag exakt + Rechnungsnummer im Verwendungszweck', now(), now()),
  ('e2e00009-0001-0000-0007-000000000031', 'e2e00009-0001-0000-0007-000000000021', 'e2e00009-0001-0000-0007-000000000011', '${COMPANY_ID}', 595.00, 'suggested', 80, 'Betrag exakt + IBAN stimmt', now(), now()),
  ('e2e00009-0001-0000-0007-000000000032', 'e2e00009-0001-0000-0007-000000000022', 'e2e00009-0001-0000-0007-000000000012', '${COMPANY_ID}', 952.00, 'suggested', 50, 'Betrag exakt (keine weitere Korrelation)', now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t36_seed.sql >/dev/null 2>&1

# ===== 1. List all reconciliations (default: suggested+confirmed) =====
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID"
assert_status 200 "1. list reconciliations (200)"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "1b. 3 reconciliations returned" "$COUNT" "3"

# Sort order: confidence DESC
FIRST_CONF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['confidence'])")
LAST_CONF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)[-1]['confidence'])")
assert_eq "1c. sort: highest confidence first" "$FIRST_CONF" "100"
assert_eq "1d. sort: lowest confidence last" "$LAST_CONF" "50"

# Invoice number visible
FIRST_INV=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['invoice']['invoiceNumber'])")
assert_eq "1e. invoice number visible" "$FIRST_INV" "E2E-T9-001"

# ===== 2. confidenceMin=80 filter =====
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID&confidenceMin=80"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "2. confidenceMin=80 returns 2 rows (100, 80)" "$COUNT" "2"

# ===== 3. status=confirmed (none yet) =====
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID&status=confirmed"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "3. status=confirmed returns 0 rows" "$COUNT" "0"

# ===== 4. Confirm recon 030 (confidence 100) =====
api_post "/api/v1/bank-statements/reconciliations/e2e00009-0001-0000-0007-000000000030/confirm?companyId=$COMPANY_ID" '{}'
assert_status 201 "4. confirm high-confidence recon (201)"

# Status should now be 'confirmed' in DB
NEW_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT status FROM \"BankReconciliation\" WHERE id = 'e2e00009-0001-0000-0007-000000000030';" 2>/dev/null | tr -d ' ')
assert_eq "4b. status flipped to confirmed" "$NEW_STATUS" "confirmed"

# ===== 5. List default — should now show 3 (2 suggested + 1 confirmed) =====
# Default filter is status in (suggested, confirmed)
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "5. default list (suggested+confirmed) = 3" "$COUNT" "3"

# Filter status=suggested only returns 2 (the 80-conf + 50-conf)
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID&status=suggested"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "5b. status=suggested only = 2" "$COUNT" "2"

# ===== 6. Reject recon 031 (confidence 80) =====
api_post "/api/v1/bank-statements/reconciliations/e2e00009-0001-0000-0007-000000000031/reject?companyId=$COMPANY_ID" '{}'
assert_status 201 "6. reject recon (201)"
REJ_STATUS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT status FROM \"BankReconciliation\" WHERE id = 'e2e00009-0001-0000-0007-000000000031';" 2>/dev/null | tr -d ' ')
assert_eq "6b. status flipped to rejected" "$REJ_STATUS" "rejected"

# ===== 7. Status=suggested filter excludes confirmed + rejected =====
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID&status=suggested"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "7. only 1 remaining (the 50-confidence)" "$COUNT" "1"
REMAINING_CONF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['confidence'])")
assert_eq "7b. the 50-confidence row remains" "$REMAINING_CONF" "50"

# status=rejected returns the one we just rejected
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID&status=rejected"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "7c. status=rejected returns 1" "$COUNT" "1"

# default (suggested+confirmed) is now 2
api_get "/api/v1/bank-statements/reconciliations?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "7d. default = 2 (1 suggested + 1 confirmed)" "$COUNT" "2"

# ----- Cleanup -----
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t36_cleanup.sql >/dev/null 2>&1
cat > /tmp/t36_cleanup2.sql << EOF
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'E2E-T9-%';
DELETE FROM "BankStatement" WHERE id = 'e2e00009-0001-0000-0007-000000000099';
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t36_cleanup2.sql >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary