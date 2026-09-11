#!/bin/bash
# Tier 366 — an untampered audit row with Decimal amounts must verify
#
# The write path hashed a live Prisma.Decimal; the verify path re-reads the
# same field from jsonb. Those were never the same value, so every audited
# model with a Decimal column (Invoice, InvoiceItem, Expense, Voucher,
# Product, CashBookEntry, Account, JournalEntry, BankTransaction) produced
# rows that reported verified=false with nothing tampered:
#
#   - Object.keys(new Prisma.Decimal("19")) is ["constructor","s","e","d"], so
#     V1 hashed decimal.js internals ("constructor" even serialised to the
#     literal `undefined`);
#   - JSON.stringify() on a Decimal gives the string "19", but Prisma stores it
#     in a Json column as the NUMBER 19 (jsonb_typeof = number), so
#     canonicalising via toJSON() is wrong too.
#
# V2 canonicalises a Decimal with toNumber(), which is what the verify path
# reads back. Rows written before Tier 366 keep their SHA-256-V1 tag and are
# still verified under V1 rules, so history is not rewritten.
#
# NOT asserted here — see HANDOFF §8: the CHAIN (previousHash) is still broken
# by an ordering/concurrency defect. `createdAt` is rounded to whole seconds
# and the tie-break is a random UUID, so the writer (max createdAt,id) and
# verifyChain (ascending createdAt,id) disagree, and concurrent writers all
# chain to the same predecessor. Fixing that needs a monotonic sequence column
# and serialised writes per company — its own tier with a migration.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

# ci-seed.sh product (Decimal basePrice / vatRate / stockQuantity).
PRODUCT_ID="99999999-0000-0000-0000-000000000001"

note "=== 1. update a product — the audit payload carries Decimals ==="
ORIG_NAME=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT name FROM \"Product\" WHERE id='$PRODUCT_ID';" 2>/dev/null | head -1)
[ -n "$ORIG_NAME" ] && pass "seeded product found: $ORIG_NAME" || fail "product $PRODUCT_ID missing from the seed"
api_put "/api/v1/products/$PRODUCT_ID?companyId=$COMPANY_ID" "{\"name\":\"Tier 366 audit probe\"}"
assert_status 200 "PUT /products/:id"

ROW_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"AuditLog\" WHERE \"entityId\"='$PRODUCT_ID' AND hash IS NOT NULL ORDER BY \"createdAt\" DESC, id DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
[ -n "$ROW_ID" ] && pass "signed audit row written: $ROW_ID" || fail "no signed audit row for the product update"
assert_eq "new rows are written as SHA-256-V2" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT \"hashAlgorithm\" FROM \"AuditLog\" WHERE id='$ROW_ID';" 2>/dev/null | tr -d ' ')" \
  "SHA-256-V2"
# The payload really does contain a Decimal — otherwise this spec proves nothing.
assert_eq "the audited payload stores basePrice as a JSON number" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT jsonb_typeof(\"newData\"->'basePrice') FROM \"AuditLog\" WHERE id='$ROW_ID';" 2>/dev/null | tr -d ' ')" \
  "number"

note "=== 2. the untampered row verifies (this was False before Tier 366) ==="
api_get "/api/v1/audit-logs/$ROW_ID/verify?companyId=$COMPANY_ID"
assert_status 200 "GET /audit-logs/:id/verify"
assert_eq "row is signed" "$(json_field "$BODY" signed)" "True"
assert_eq "row verifies" "$(json_field "$BODY" verified)" "True"
assert_eq "storedHash == recomputedHash" \
  "$(json_field "$BODY" storedHash)" "$(json_field "$BODY" recomputedHash)"

note "=== 3. tampering with that row still flips it to verified=false ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "UPDATE \"AuditLog\" SET \"newData\" = jsonb_set(\"newData\", '{basePrice}', '999999') WHERE id='$ROW_ID';" >/dev/null 2>&1
api_get "/api/v1/audit-logs/$ROW_ID/verify?companyId=$COMPANY_ID"
assert_eq "tampered row does not verify" "$(json_field "$BODY" verified)" "False"

note "=== 4. Cleanup ==="
# Delete the probe's audit rows (the tampered one included) and restore the name.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "DELETE FROM \"AuditLog\" WHERE id='$ROW_ID';" >/dev/null 2>&1
LEFT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"AuditLog\" WHERE id='$ROW_ID';" 2>/dev/null | tr -d ' ')
assert_eq "probe audit row removed" "$LEFT" "0"
api_put "/api/v1/products/$PRODUCT_ID?companyId=$COMPANY_ID" "{\"name\":\"$ORIG_NAME\"}"
assert_status 200 "restore product name"

summary
