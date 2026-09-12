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
# Tier 367 added the chain assertions below: a monotonic `seq` column plus a
# per-company advisory lock around read-previous/hash/insert. Before that the
# writer took max(createdAt, id) while verifyChain walked ascending — with
# second-rounded timestamps and random UUIDs the two disagreed, and concurrent
# writers all chained to the same predecessor (measured: 15 rows in one second,
# a mid-chain row with an empty previousHash, a dozen sharing one predecessor).
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

note "=== 3. the chain verifies as the application wrote it (Tier 367) ==="
# No re-hash: scripts/audit-rehash.ts rewrites every pointer, which is exactly
# what hid the ordering bug from audit-hash-chain-tier196 for ten tiers.
api_get "/api/v1/audit-logs/verify?companyId=$COMPANY_ID"
assert_status 200 "GET /audit-logs/verify"
CHAIN_REASON=$(echo "$BODY" | python3 -c "import json,sys; b=json.load(sys.stdin).get('brokenAt') or {}; print('%s %s' % (b.get('reason',''), b.get('id','')))" 2>/dev/null)
assert_eq "chain ok (brokenAt: ${CHAIN_REASON:-none})" "$(json_field "$BODY" ok)" "True"

note "=== 4. concurrent writes keep the chain intact (Tier 367) ==="
# Six parallel updates on the same company. Before Tier 367 every writer read
# the same "newest" row and chained to it, so the walk broke at the second one.
for i in 1 2 3 4 5 6; do
  curl -sS -o /dev/null -X PUT \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json" \
    -d "{\"name\":\"Tier 367 parallel $i\"}" \
    "$API/api/v1/products/$PRODUCT_ID?companyId=$COMPANY_ID" &
done
wait
PARALLEL_ROWS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\"='$PRODUCT_ID' AND hash IS NOT NULL;" 2>/dev/null | tr -d ' ')
test "${PARALLEL_ROWS:-0}" -ge 6 && pass "parallel updates wrote $PARALLEL_ROWS signed rows" \
  || fail "expected >= 6 signed rows from the parallel updates, got ${PARALLEL_ROWS:-0}"
DISTINCT_PREV=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(DISTINCT \"previousHash\") FROM \"AuditLog\" WHERE \"entityId\"='$PRODUCT_ID' AND hash IS NOT NULL;" 2>/dev/null | tr -d ' ')
assert_eq "each concurrent row chained to a different predecessor" "$DISTINCT_PREV" "$PARALLEL_ROWS"
api_get "/api/v1/audit-logs/verify?companyId=$COMPANY_ID"
CHAIN_REASON2=$(echo "$BODY" | python3 -c "import json,sys; b=json.load(sys.stdin).get('brokenAt') or {}; print('%s %s' % (b.get('reason',''), b.get('id','')))" 2>/dev/null)
assert_eq "chain ok after concurrent writes (brokenAt: ${CHAIN_REASON2:-none})" "$(json_field "$BODY" ok)" "True"

note "=== 5. tampering with that row still flips it to verified=false ==="
# Deliberately LAST before cleanup: this leaves a row whose stored hash no
# longer matches its content, so every chain assertion has to run before it.
# (Tier 367 first put this at step 3 and then asserted chain integrity at
# steps 4-5 — with the tampered row still in the table. The assertions were
# wrong by construction, not the chain.)
# Tier 368: save the payload first so cleanup can put it back (see below).
ORIG_NEWDATA=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COALESCE(\"newData\"::text, '') FROM \"AuditLog\" WHERE id='$ROW_ID';" 2>/dev/null | head -1)
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "UPDATE \"AuditLog\" SET \"newData\" = jsonb_set(\"newData\", '{basePrice}', '999999') WHERE id='$ROW_ID';" >/dev/null 2>&1
api_get "/api/v1/audit-logs/$ROW_ID/verify?companyId=$COMPANY_ID"
assert_eq "tampered row does not verify" "$(json_field "$BODY" verified)" "False"

note "=== 6. Cleanup: restore the row, never delete it (Tier 368) ==="
# This used to DELETE the probe rows. Deleting a SIGNED audit row breaks the
# chain for everything after it: the next row's previousHash then points at a
# hash that exists nowhere, and verifyChain reports previous_hash_mismatch.
# Measured after Tier 368 put the auth/assets/company rows into the chain —
# seq 334 and 335 were simply gone, and specs 170 and 171 both broke on it.
# Audit rows are append-only by design, so restore the tampered payload and
# leave the concurrent-probe rows alone: they are legitimate audit history.
ESCAPED_NEWDATA=$(printf '%s' "$ORIG_NEWDATA" | sed "s/'/''/g")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "UPDATE \"AuditLog\" SET \"newData\" = '$ESCAPED_NEWDATA'::jsonb WHERE id='$ROW_ID';" >/dev/null 2>&1
api_get "/api/v1/audit-logs/$ROW_ID/verify?companyId=$COMPANY_ID"
assert_eq "the restored row verifies again" "$(json_field "$BODY" verified)" "True"
api_get "/api/v1/audit-logs/verify?companyId=$COMPANY_ID"
CHAIN_REASON3=$(echo "$BODY" | python3 -c "import json,sys; b=json.load(sys.stdin).get('brokenAt') or {}; print('%s %s' % (b.get('reason',''), b.get('id','')))" 2>/dev/null)
assert_eq "chain intact on exit (brokenAt: ${CHAIN_REASON3:-none})" "$(json_field "$BODY" ok)" "True"
api_put "/api/v1/products/$PRODUCT_ID?companyId=$COMPANY_ID" "{\"name\":\"$ORIG_NAME\"}"
assert_status 200 "restore product name"

summary
