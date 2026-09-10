#!/bin/bash
# Test 32: Tier 6.5 — FinTS auto-sync + smart match
#
# Three categories of new behaviour:
#
# A. **Auto-sync cron** — every 4 hours, walks
#    all FinTSConnection.status='active',
#    triggers startSync() for each. Manual
#    override: POST /fints/auto-run. The
#    last-run outcome is readable via
#    GET /fints/last-auto-run.
#
# B. **Smart match — Rule A (±0.50 EUR)**
#    a payment of 2379.80 matches an open
#    invoice for 2380.00 (20ct FX rounding).
#    Without this rule the user has to
#    manually confirm a "wrong" amount.
#    Confidence 95 when invoice# in purpose
#    (high signal), 90 when IBAN also
#    matches, 30 otherwise.
#
# C. **Smart match — Rule B (sum-to-invoice)**
#    two incoming payments of 1190.00 sum
#    to 2380.00 (an open invoice). Without
#    this rule the user has to manually
#    match each leg. Confidence 95.
#
# D. **Smart match — Rule C (name fuzzy)**
#    a payment whose purpose contains the
#    customer name with up to 2 character
#    edits (e.g. "Muller" vs "Müller")
#    matches. Confidence 70-80.
#
# NOTE: this test seeds data via SQL
# files (not inline heredocs) because the
# camelCase columns (`rawContent`,
# `endToEndId`, etc.) need to be double-
# quoted in Postgres. Inline heredocs in
# bash have a tendency to silently drop
# the quotes depending on shell quoting
# rules, leading to "column does not
# exist" errors that look like missing
# data. Writing the SQL to a file
# sidesteps the quoting issue entirely.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 6.5 FinTS auto-sync + smart match ==="
# ----- Clean prior state -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';
  DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"FinTSSyncRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"FinTSConnection\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'E2E-T6S-%';" >/dev/null 2>&1

CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')

if [[ -z "$CUST_ID" ]]; then
  fail "No customer found — create one first"
  exit 1
fi

# ===== A. Auto-sync cron =====
# Create a connection + skip the TAN step
# (set status='active' + systemId).
api_post "/api/v1/fints/connections" "{\"companyId\":\"$COMPANY_ID\",\"blz\":\"50050201\",\"userId\":\"e2e-test-user\",\"label\":\"E2E Auto\",\"pin\":\"12345\",\"mockMode\":true}"
CONN_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"FinTSConnection\" SET status='active', \"systemId\"='MOCK-test-123' WHERE id='$CONN_ID';" >/dev/null 2>&1

# Trigger auto-run
api_post "/api/v1/fints/auto-run" "{}"
assert_status 201 "A1. auto-run returns 201"
CONNS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['connections'])")
assert_eq "A2. auto-run saw 1 active connection" "$CONNS" "1"
OK=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])")
assert_eq "A3. that connection succeeded" "$OK" "1"

# Read last-auto-run
api_get "/api/v1/fints/last-auto-run"
assert_status 200 "A4. last-auto-run returns 200"
LAST_OK=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])")
assert_eq "A5. last-auto-run shows same ok count" "$LAST_OK" "1"

# Verify 3 mock transactions landed in DB
DB_TX=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankTransaction\"
  WHERE \"companyId\" = '$COMPANY_ID' AND \"endToEndId\" LIKE 'MOCK-%';" 2>/dev/null | tr -d ' ')
assert_eq "A6. 3 mock transactions in DB after auto-run" "$DB_TX" "3"

# ===== B. Smart match — Rule A (±0.50 EUR) =====
# Seed an open invoice for 2380.00 + a payment
# of 2379.80 (20ct FX rounding) whose purpose
# includes the invoice number. Expected
# confidence 95.
cat > /tmp/t32_seed_b.sql << EOF
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", notes, "templateType", "pdfPath", attachments, "createdAt", "updatedAt")
VALUES ('e2e00006-0001-0000-0007-000000000020', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T6S-001', 9920,
 'INV', 'sent', '2026-06-01', '2026-07-01', 2000.00, 380.00, 2380.00, 'EUR', 'de-DE',
 '[{"rate":0.19}]'::jsonb, false, false, 'T6S', 'standard', NULL, '[]', now(), now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t32_seed_b.sql >/dev/null 2>&1

# A new BankStatement + BankTransaction for
# the FX-diff payment. We can't use the
# auto-sync here because the auto-sync uses
# deterministic mock transactions, not
# this 2379.80 amount. Seed manually.
cat > /tmp/t32_seed_b2.sql << EOF
INSERT INTO "BankStatement" (id, "companyId", format, "fileName", "fileSize", "rawContent", "createdAt")
VALUES ('e2e00006-0001-0000-0007-000000000021', '${COMPANY_ID}', 'fints-mock', 'manual.json', 100, '[]', now());
INSERT INTO "BankTransaction" (id, "statementId", "companyId", "valueDate", "entryDate", amount, currency, purpose, "endToEndId", "createdAt")
VALUES ('e2e00006-0001-0000-0007-000000000022', 'e2e00006-0001-0000-0007-000000000021', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 2379.80, 'EUR', 'FX-Rundung E2E-T6S-001', 'MOCK-T6S-fxdiff-001', now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t32_seed_b2.sql >/dev/null 2>&1

api_post "/api/v1/fints/auto-match" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "B1. auto-match (with FX diff) returns 201"
MATCHED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['matched'])")
if [[ "$MATCHED" -ge 1 ]]; then
  pass "B2. ±0.50 EUR tolerance produced a match"
else
  fail "B2. expected ≥1 match, got $MATCHED"
fi

RECON_CONF=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT confidence FROM \"BankReconciliation\"
  WHERE \"invoiceId\" = 'e2e00006-0001-0000-0007-000000000020'
    AND \"bankTransactionId\" = 'e2e00006-0001-0000-0007-000000000022';" 2>/dev/null | tr -d ' ')
assert_eq "B3. confidence for FX-diff match = 95" "$RECON_CONF" "95"

RECON_REASON=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"matchReason\" FROM \"BankReconciliation\"
  WHERE \"invoiceId\" = 'e2e00006-0001-0000-0007-000000000020'
    AND \"bankTransactionId\" = 'e2e00006-0001-0000-0007-000000000022';" 2>/dev/null | tr -d ' ')
if [[ "$RECON_REASON" == *"FX"* ]]; then
  pass "B4. matchReason mentions FX rounding"
else
  fail "B4. matchReason = $RECON_REASON (expected FX)"
fi

# ===== C. Smart match — Rule B (sum-to-invoice) =====
# Seed an open invoice with a unique total
# (not in the auto-sync mock set: 2380, 1190,
# -12.50). Use 2000.00, with two 1000.00
# installments. The two payments sum to
# 2000.00 so the matcher should pair them
# to the new invoice (T6S-002) with
# confidence 95.
cat > /tmp/t32_seed_c.sql << EOF
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", notes, "templateType", "pdfPath", attachments, "createdAt", "updatedAt")
VALUES ('e2e00006-0001-0000-0007-000000000030', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T6S-002', 9921,
 'INV', 'sent', '2026-06-01', '2026-07-01', 1680.67, 319.33, 2000.00, 'EUR', 'de-DE',
 '[{"rate":0.19}]'::jsonb, false, false, 'T6S sum', 'standard', NULL, '[]', now(), now());
INSERT INTO "BankTransaction" (id, "statementId", "companyId", "valueDate", "entryDate", amount, currency, purpose, "endToEndId", "createdAt")
VALUES
  ('e2e00006-0001-0000-0007-000000000031', 'e2e00006-0001-0000-0007-000000000021', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 1000.00, 'EUR', 'Anzahlung 50% E2E-T6S-002', 'MOCK-T6S-anz-001', now()),
  ('e2e00006-0001-0000-0007-000000000032', 'e2e00006-0001-0000-0007-000000000021', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 1000.00, 'EUR', 'Rest 50% E2E-T6S-002', 'MOCK-T6S-anz-002', now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t32_seed_c.sql >/dev/null 2>&1

api_post "/api/v1/fints/auto-match" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "C1. auto-match (sum-to-invoice) returns 201"

# Both transactions should now be matched to invoice 030
RECON_COUNT_030=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankReconciliation\"
  WHERE \"invoiceId\" = 'e2e00006-0001-0000-0007-000000000030';" 2>/dev/null | tr -d ' ')
assert_eq "C2. 2 recon rows for sum-to-invoice" "$RECON_COUNT_030" "2"

RECON_REASON_030=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"matchReason\" FROM \"BankReconciliation\"
  WHERE \"invoiceId\" = 'e2e00006-0001-0000-0007-000000000030' LIMIT 1;" 2>/dev/null | tr -d ' ')
if [[ "$RECON_REASON_030" == *"Summe"* ]]; then
  pass "C3. matchReason mentions 'Summe' (sum-to-invoice)"
else
  fail "C3. matchReason = $RECON_REASON_030 (expected Summe)"
fi

# ===== D. Smart match — Rule C (name fuzzy) =====
# Seed a Müller customer (or rename existing
# one), create an invoice, then a payment
# whose purpose contains "Muller" (no ü).
# Levenshtein distance is 1 (ü→u) so the
# match should fire.
MULLER_NAME="Müller GmbH"
# Tier 297: use a unique amount (593.99) instead of 595.00
# so the auto-match loop doesn't pick a stale fixture invoice
# (e.g. tier 44 spec) with the same 595 total. We need exact
# match + name fuzzy, but the auto-match loop's `break` on
# first match means the FIRST invoice with that amount wins.
# 593.99 is unique to this test run.
cat > /tmp/t32_seed_d.sql << EOF
UPDATE "Customer" SET name='${MULLER_NAME}' WHERE id='${CUST_ID}';
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", notes, "templateType", "pdfPath", attachments, "createdAt", "updatedAt")
VALUES ('e2e00006-0001-0000-0007-000000000040', '${COMPANY_ID}', '${CUST_ID}', 'E2E-T6S-003', 9922,
 'INV', 'sent', '2026-06-01', '2026-07-01', 499.15, 94.84, 593.99, 'EUR', 'de-DE',
 '[{"rate":0.19}]'::jsonb, false, false, 'T6S fuzzy', 'standard', NULL, '[]', now(), now());
INSERT INTO "BankTransaction" (id, "statementId", "companyId", "valueDate", "entryDate", amount, currency, purpose, "endToEndId", "createdAt")
VALUES ('e2e00006-0001-0000-0007-000000000041', 'e2e00006-0001-0000-0007-000000000021', '${COMPANY_ID}', '2026-06-15', '2026-06-15', 593.99, 'EUR', 'Rechnung von Muller GmbH', 'MOCK-T6S-fuzzy-001', now());
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t32_seed_d.sql >/dev/null 2>&1

api_post "/api/v1/fints/auto-match" "{\"companyId\":\"$COMPANY_ID\"}"
assert_status 201 "D1. auto-match (name fuzzy) returns 201"

RECON_COUNT_040=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"BankReconciliation\"
  WHERE \"invoiceId\" = 'e2e00006-0001-0000-0007-000000000040';" 2>/dev/null | tr -d ' ')
if [[ "$RECON_COUNT_040" -ge 1 ]]; then
  pass "D2. Name-fuzzy match produced a recon"
else
  fail "D2. no recon for fuzzy name match"
fi

# ----- Cleanup -----
cat > /tmp/t32_cleanup.sql << EOF
DELETE FROM "BankReconciliation" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "BankTransaction" WHERE "companyId" = '${COMPANY_ID}' AND ("endToEndId" LIKE 'MOCK-%' OR "statementId" = 'e2e00006-0001-0000-0007-000000000021');
DELETE FROM "BankStatement" WHERE id = 'e2e00006-0001-0000-0007-000000000021';
DELETE FROM "FinTSSyncRun" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSConnection" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'E2E-T6S-%';
UPDATE "Customer" SET name='Müller GmbH' WHERE id='${CUST_ID}';
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < /tmp/t32_cleanup.sql >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
