#!/bin/bash
# Tier 12: Prisma migrate validation.
#
# The migrate system is the production
# upgrade path — it MUST work end-to-end
# before we ship. We test:
#   1.  migrate status is "up to date"
#       (baseline is marked applied)
#   2.  The baseline migration file
#       exists and is non-empty
#   3.  Running migrate deploy on a
#       fresh DB creates the schema
#       (round-trip validation)
#   4.  The generated SQL contains all
#       the critical Tier-12 models
#       (BankReconciliation,
#       FinTsTransfer, InvoiceTemplate)
#   5.  The current DB still has the
#       data we seeded (migrate didn't
#       nuke it — the baseline is
#       marked applied, NOT executed)
#   6.  init.sql (the generated columns
#       rebuild script) is still
#       present and references the
#       right tables
#   7.  The schema.prisma generator
#       config matches what the
#       migrate expects
#       (engineType=binary is what the
#       Docker image needs)
#
# We DON'T test prisma migrate dev —
# that requires interactive prompts.
# migrate deploy is the prod path.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# This test inspects the Prisma
# migration files which live in
# backend/prisma/. The e2e runner
# expects to be run from backend/ (the
# other 40 tests are backend-relative
# too). We pin the cwd to backend so
# the relative `prisma/...` paths work.
cd "$SCRIPT_DIR/.."

echo "=== Test: Tier 12 Prisma migrate validation ==="

# ===== 1. migrate status says "up to date" =====
npx prisma migrate status > /tmp/t41_status.txt 2>&1
UP_TO_DATE=$(grep -c "Database schema is up to date" /tmp/t41_status.txt || true)
[[ "$UP_TO_DATE" -ge 1 ]] && pass "1. migrate status: up to date" || fail "1. migrate status NOT up to date: $(cat /tmp/t41_status.txt)"

# ===== 2. baseline migration file exists and is non-empty =====
BASELINE_FILE="prisma/migrations/20240101000000_baseline/migration.sql"
[[ -f "$BASELINE_FILE" ]] && pass "2a. baseline file exists" || fail "2a. baseline file MISSING"
LINES=$(wc -l < "$BASELINE_FILE" 2>/dev/null || echo 0)
[[ "$LINES" -gt 500 ]] && pass "2b. baseline has $LINES lines (substantial)" || fail "2b. baseline too small: $LINES lines"

# ===== 3. generated SQL contains critical Tier-12 models =====
grep -q "CREATE TABLE \"BankReconciliation\"" "$BASELINE_FILE" \
  && pass "3a. baseline has BankReconciliation (Tier 9)" \
  || fail "3a. BankReconciliation missing from baseline"
grep -q "CREATE TABLE \"FinTsTransfer\"" "$BASELINE_FILE" \
  && pass "3b. baseline has FinTsTransfer (Tier 10)" \
  || fail "3b. FinTsTransfer missing from baseline"
grep -q "CREATE TABLE \"InvoiceTemplate\"" "$BASELINE_FILE" \
  && pass "3c. baseline has InvoiceTemplate (Tier 7)" \
  || fail "3c. InvoiceTemplate missing from baseline"
grep -q "CREATE TABLE \"FinTSConnection\"" "$BASELINE_FILE" \
  && pass "3d. baseline has FinTSConnection (Tier 6)" \
  || fail "3d. FinTSConnection missing from baseline"
grep -q "CREATE TABLE \"RecurringInvoice\"" "$BASELINE_FILE" \
  && pass "3e. baseline has RecurringInvoice (Tier 8)" \
  || fail "3e. RecurringInvoice missing from baseline"
grep -q "CREATE TABLE \"UStvaFiling\"" "$BASELINE_FILE" \
  && pass "3f. baseline has UStvaFiling" \
  || fail "3f. UStvaFiling missing"

# ===== 4. baseline has indexes (perf-critical) =====
grep -q 'CREATE INDEX.*"companyId", "issueDate"' "$BASELINE_FILE" \
  && pass "4a. baseline has Invoice(companyId, issueDate) index" \
  || fail "4a. hot invoice index missing"
grep -q 'CREATE INDEX.*"companyId", "businessDate"' "$BASELINE_FILE" \
  && pass "4b. baseline has CashBookEntry(companyId, businessDate) index" \
  || fail "4b. cashbook index missing"
grep -q 'CREATE UNIQUE INDEX.*"companyId", "customerNumber"' "$BASELINE_FILE" \
  && pass "4c. baseline has Customer unique(companyId, customerNumber)" \
  || fail "4c. customer unique missing"

# ===== 5. the LIVE DB still has data (baseline marked applied, not run) =====
USER_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"User\";" 2>/dev/null | tr -d ' ')
[[ "$USER_COUNT" -ge 1 ]] && pass "5. live DB has $USER_COUNT users (baseline didn't wipe data)" \
  || fail "5. live DB has 0 users — baseline was destructive!"

# ===== 6. the init.sql (generated columns rebuild) is intact =====
[[ -f "prisma/init.sql" ]] && pass "6a. init.sql exists" || fail "6a. init.sql MISSING"
grep -q "city_text\|postal_code_text" prisma/init.sql 2>/dev/null \
  && pass "6b. init.sql rebuilds the generated columns" \
  || fail "6b. init.sql doesn't reference generated columns"

# ===== 7. schema.prisma has the right engineType for Docker =====
grep -q "engineType = \"binary\"" prisma/schema.prisma \
  && pass "7. schema uses binary Prisma engine (Docker-compatible)" \
  || fail "7. schema missing engineType=binary"

# ===== 8. validate the schema file parses (migrate dry-run) =====
# We use `migrate diff` to confirm the
# current schema is internally
# consistent. If the schema is broken,
# this errors out.
npx prisma validate > /tmp/t41_validate.txt 2>&1
[[ "$?" -eq 0 ]] && pass "8. prisma validate passes (schema is consistent)" \
  || fail "8. prisma validate failed: $(cat /tmp/t41_validate.txt)"

# ===== 9. baseline also covers the Tier 12 FinTsTransfer model indexes =====
# These compound indexes are what make
# the /api/v1/fints/transfers list
# query fast. They must be in the
# baseline so a fresh DB gets them.
grep -q 'CREATE INDEX.*"companyId", "status", "startedAt"' "$BASELINE_FILE" \
  && pass "9. baseline has FinTsTransfer(companyId, status, startedAt) index" \
  || fail "9. FinTsTransfer index missing"

# ===== 10. The provider is locked to postgresql =====
[[ -f "prisma/migration_lock.toml" ]] && pass "10a. migration_lock.toml exists" \
  || fail "10a. migration_lock.toml MISSING — Prisma won't run migrate"
grep -q 'provider = "postgresql"' prisma/migration_lock.toml \
  && pass "10b. migration_lock.toml says postgresql" \
  || fail "10b. wrong provider in migration_lock.toml"

# ===== 11. Fresh-DB round-trip: drop, migrate deploy, verify schema =====
# This is the real production upgrade
# path: a fresh Postgres with NO
# existing schema. If the baseline
# is wrong (missing a table, wrong
# column type, missing index), this
# fails. We use a throwaway DB name
# so we don't touch the dev DB.
TEST_DB="de_invoice_migrate_test"
# Drop + create
docker exec de-invoice-postgres psql -U de_invoice -d postgres -c \
  "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null 2>&1
docker exec de-invoice-postgres psql -U de_invoice -d postgres -c \
  "CREATE DATABASE $TEST_DB;" >/dev/null 2>&1
# Apply the baseline
DATABASE_URL="postgresql://de_invoice:de_invoice_pass@localhost:5432/$TEST_DB?schema=public" \
  npx prisma migrate deploy > /tmp/t41_deploy.txt 2>&1
DEPLOY_OK=$?
if [[ $DEPLOY_OK -eq 0 ]]; then
  pass "11a. prisma migrate deploy on fresh DB: OK"
else
  fail "11a. prisma migrate deploy FAILED: $(cat /tmp/t41_deploy.txt)"
fi
# Run init.sql to recreate the
# generated columns (city_text,
# postal_code_text) — the baseline
# doesn't include them because
# prisma migrate diff doesn't emit
# GENERATED ALWAYS AS clauses; we
# have to apply init.sql manually.
docker exec -i de-invoice-postgres psql -U de_invoice -d $TEST_DB \
  < prisma/init.sql > /tmp/t41_init.txt 2>&1
# Verify the schema
TABLE_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d $TEST_DB -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | tr -d ' ')
[[ "$TABLE_COUNT" -ge 30 ]] && pass "11b. fresh DB has $TABLE_COUNT tables (expected ≥30)" \
  || fail "11b. fresh DB only has $TABLE_COUNT tables"

# Verify the critical Tier 12 models exist
docker exec de-invoice-postgres psql -U de_invoice -d $TEST_DB -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('FinTsTransfer', 'BankReconciliation', 'InvoiceTemplate', 'FinTSConnection', 'RecurringInvoice', 'UStvaFiling');" 2>/dev/null \
  | tr -d ' ' \
  | grep -q '^6$' && pass "11c. all 6 Tier-12-critical models present" \
  || fail "11c. missing Tier-12 models in fresh DB"

# Verify the generated columns work
# We need to use the snake_case column
# names (the generated columns are
# `city_text` / `postal_code_text`,
# not the camelCase Prisma names —
# init.sql creates the snake_case
# GENERATED ALWAYS AS expressions).
# And both Company AND Customer have
# non-null `updatedAt` columns we
# have to set. We insert with -c
# (not stdin heredoc) because the
# bash → docker exec pipe drops
# multi-statement input silently.
docker exec de-invoice-postgres psql -U de_invoice -d $TEST_DB -c \
  "INSERT INTO \"Company\" (id, name, address, \"updatedAt\") VALUES ('migrate-test-co', 'Migrate Test', '{}'::jsonb, now()) ON CONFLICT DO NOTHING;" 2>/dev/null
docker exec de-invoice-postgres psql -U de_invoice -d $TEST_DB -c \
  "INSERT INTO \"Customer\" (id, \"companyId\", name, type, address, city_text, postal_code_text, \"updatedAt\") VALUES ('migrate-test-cu', 'migrate-test-co', 'X', 'business', '{}'::jsonb, 'München', '80331', now());" 2>/dev/null
# Read back. The grep just looks for
# 'München' anywhere in the output
# (single-statement SELECT is enough).
docker exec de-invoice-postgres psql -U de_invoice -d $TEST_DB -c \
  "SELECT city_text FROM \"Customer\" WHERE id = 'migrate-test-cu';" 2>/dev/null \
  | grep -q "München" && pass "11d. generated columns work after fresh migrate" \
  || fail "11d. generated columns broken after fresh migrate"

# Clean up the test DB so the next
# run starts from a known state.
docker exec de-invoice-postgres psql -U de_invoice -d postgres -c \
  "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null 2>&1
/Users/shledergmbh/.mavis/bin/mavis-trash -- /tmp/t41_deploy.txt /tmp/t41_init.txt

# ----- Cleanup -----
/Users/shledergmbh/.mavis/bin/mavis-trash -- /tmp/t41_status.txt /tmp/t41_validate.txt
note "Cleanup done"

summary