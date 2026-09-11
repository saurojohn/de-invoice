#!/usr/bin/env bash
# e2e 137: Tier 112 — SEPA pain.008 (Lastschrift / Direct Debit)
#
# Validates the new incoming-payment flow:
#   - GET  /payments/mandates                 list mandates
#   - POST /payments/mandates                 create mandate
#   - DELETE /payments/mandates/:id           revoke mandate
#   - GET  /payments/direct-debit/open        list open invoices
#   - POST /payments/direct-debit/batches     create batch
#   - GET  /payments/direct-debit/batches     list past batches
#   - GET  /payments/direct-debit/batches/:id get one batch
#   - GET  /payments/direct-debit/batches/:id/xml
#                                            download pain.008 XML
#
# Test plan (17 sections, 60+ assertions):
#   0.  Wipe prior tier-112 fixtures (idempotent re-runs)
#   1.  Setup: create customer + 3 sent invoices
#   2.  Mandate CRUD: empty list → create → list → revoke
#   3.  Mandate validation: missing customerId, bad IBAN,
#       bad date, unknown customer → 400
#   4.  Open invoices: customer without mandate excluded;
#       customer with mandate shows the 3 invoices
#   5.  Batch generation: select 2 of 3, generate, verify
#       totalAmount = Σ invoice.total
#   6.  XML structure: pain.008.001.02 namespace +
#       GrpHdr + PmtInf + DrctDbtTxInf × 2
#   7.  Math identity: CtrlSum = Σ DrctDbtTxInf.InstdAmt
#   8.  B2B mandate: separate flow, 1-day pre-notif deadline
#   9.  Validation: empty collections / bad date / missing
#       companyId / mixed CORE+B2B → 400
#   10. Mark invoice as collected: GET /invoices/:id shows
#       collectedBySepaBatchId + open-invoices list excludes
#       the collected invoice
#   11. Cross-tenant: no x-user-id → 401
#   12. XML download: Content-Disposition + magic bytes
#   13. Revoked mandate cannot be used in new batch → 400
#   14. Mismatched mandate (wrong customer) → 400
#   15. Auto-generated mandate reference format
#   16. Two mandates for same customer, both active
#   17. Cleanup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Tier 361: batch creation takes the creditor IBAN from Company.bankInfo
# (payments/direct-debit.service.ts) and answers 400 "Gläubiger-IBAN fehlt"
# without one. The developer database's company had bank details; the CI
# seed's does not, so every batch step failed the first time this spec ran.
# Merge an IBAN/BIC in for the run and put the original bankInfo back on exit.
T112_ORIG_BANKINFO=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT coalesce(\"bankInfo\"::text, '') FROM \"Company\" WHERE id='$COMPANY_ID';" 2>/dev/null | tr -d '\n')
t112_restore_bankinfo() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
    "UPDATE \"Company\" SET \"bankInfo\" = NULLIF('${T112_ORIG_BANKINFO}', '')::jsonb WHERE id='$COMPANY_ID';" >/dev/null 2>&1
}
trap t112_restore_bankinfo EXIT
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "UPDATE \"Company\" SET \"bankInfo\" = coalesce(\"bankInfo\", '{}'::jsonb) || '{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null

TS=$(date +%s)
PREFIX="Tier112-$TS"

note "=== Test prefix: $PREFIX ==="

# ───── 0. Wipe prior tier-112 fixtures (idempotent re-runs) ─────
# The unique-customer-email index means we need to delete the
# customer before re-creating it on a re-run. Same for
# invoices (FK from collection) and the mandates.
# Note: invoiceNumber is auto-assigned by the service, so
# we filter by customer name (which includes the PREFIX) +
# mandateReference (we'll pass an explicit PREFIX-tagged ref).
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "SepaDirectDebitCollection" WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "SepaDirectDebitBatch"     WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "SepaDirectDebitMandate"   WHERE "companyId" = '$COMPANY_ID'
  AND ("mandateReference" LIKE 'MANDATE-${PREFIX}%'
    OR "description" LIKE '${PREFIX}%'
    OR "debitorName" LIKE '${PREFIX}%');
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "customerId" IN (
    SELECT id FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%'
  )
);
DELETE FROM "Invoice" WHERE "customerId" IN (
  SELECT id FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%'
);
DELETE FROM "Customer"    WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%';
SQL
pass "wiped prior tier-112 fixtures"

# ───── 1. Setup: customer + 3 sent invoices ─────
echo
note "=== 1. Setup: customer + 3 sent invoices ==="
api_post "/api/v1/customers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-Kunde\",
    \"type\": \"business\",
    \"address\": {\"street\":\"Musterstr. 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"},
    \"contact\": {\"email\":\"${PREFIX}@example.com\"}
  }"
assert_status "201" "create customer"
CUST_ID=$(json_field "$BODY" "id")
[[ -n "$CUST_ID" ]] && pass "customer id = $CUST_ID" || fail "no customer id"

# 3 sent invoices: 119, 238, 357 EUR gross (100/200/300 net + 19% VAT).
# The invoice service auto-assigns the invoice number on POST
# (per-company sequential), so we don't pass `invoiceNumber` in
# the request body — passing it triggers a 400 ("property
# invoiceNumber should not exist"). We track the created
# invoices by ID instead of by number, and use the PREFIX
# in the description for cleanup `LIKE` matching.
declare -a INV_IDS=()
declare -a INV_AMOUNTS=()
for i in 1 2 3; do
  AMT_NET=$((100 * i))
  AMT_VAT=$((19 * i))
  AMT_GROSS=$((AMT_NET + AMT_VAT))
  api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
    "{
      \"customerId\": \"$CUST_ID\",
      \"issueDate\": \"2026-07-01\",
      \"dueDate\": \"2026-07-15\",
      \"items\": [{\"description\":\"$PREFIX item $i\",\"quantity\":1,\"unitPrice\":$AMT_NET,\"vatRate\":0.19}]
    }"
  assert_status "201" "create invoice $i ($AMT_GROSS EUR gross)"
  IID=$(json_field "$BODY" "id")
  [[ -n "$IID" ]] && pass "  invoice $i id = $IID" || fail "  no invoice id"
  INV_IDS+=("$IID")
  INV_AMOUNTS+=("$AMT_GROSS")
  # Move invoice to status=sent so the open-invoices list picks it up
  api_put "/api/v1/invoices/$IID/status?companyId=$COMPANY_ID" '{"status":"sent"}'
  assert_status "200" "invoice $i → sent"
done

# Expected total for 2 invoices (we'll select INV-1 + INV-2): 119 + 238 = 357
# The backend serialises the totalAmount as a plain number
# (`Math.round(... * 100) / 100`), so 357.00 round-trips
# as 357 (no trailing zeros). We compare as numbers.
EXPECTED_BATCH_TOTAL="357"

# ───── 2. Mandate CRUD ─────
echo
note "=== 2. Mandate CRUD ==="

# 2a. List mandates → 0 for our prefix
api_get "/api/v1/payments/mandates?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/mandates"
INITIAL_COUNT=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([m for m in d if m.get('mandateReference','').startswith('MANDATE-${PREFIX}')]))")
assert_eq "initial mandate count for prefix" "$INITIAL_COUNT" "0"

# 2b. Create mandate
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013000\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde GmbH\",
    \"description\": \"Mitgliedsbeitrag 2026\"
  }"
assert_status "201" "create CORE mandate"
MANDATE_ID=$(json_field "$BODY" "id")
MANDATE_REF=$(json_field "$BODY" "mandateReference")
MANDATE_TYPE=$(json_field "$BODY" "type")
MANDATE_STATUS=$(json_field "$BODY" "status")
[[ -n "$MANDATE_ID" ]] && pass "mandate id = $MANDATE_ID" || fail "no mandate id"
assert_eq "mandate type" "$MANDATE_TYPE" "CORE"
assert_eq "mandate status" "$MANDATE_STATUS" "active"
# Auto-generated reference should be MANDATE-{customerNumber-or-uuid-prefix}-{date}-0001
echo "  auto-generated ref: $MANDATE_REF"
if [[ "$MANDATE_REF" =~ ^MANDATE-.+-[0-9]{8}-[0-9]{4}$ ]]; then
  pass "mandate reference format MANDATE-...-{YYYYMMDD}-NNNN ✓"
else
  fail "mandate reference format unexpected: $MANDATE_REF"
fi

# 2c. List now has 1 for our customer
# (we filter by customerId, not by mandateReference prefix —
# the auto-generated ref uses customerNumber, not PREFIX)
api_get "/api/v1/payments/mandates?companyId=$COMPANY_ID"
AFTER_COUNT=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([m for m in d if m.get('customerId') == '$CUST_ID']))")
assert_eq "mandate count after create" "$AFTER_COUNT" "1"

# 2d. Revoke the mandate (we'll re-create later for the batch tests)
api_delete "/api/v1/payments/mandates/$MANDATE_ID?companyId=$COMPANY_ID&reason=test+cleanup" "" >/dev/null
assert_status "200" "revoke mandate"
REVOKED_STATUS=$(json_field "$BODY" "status")
assert_eq "revoked mandate status" "$REVOKED_STATUS" "revoked"
REVOKED_AT=$(json_field "$BODY" "revokedAt")
[[ -n "$REVOKED_AT" ]] && pass "revokedAt timestamp set: $REVOKED_AT" || fail "revokedAt empty"

# 2e. Re-create a fresh CORE mandate (we need an active one for batch tests)
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013000\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde GmbH\"
  }"
assert_status "201" "re-create CORE mandate"
MANDATE_ID=$(json_field "$BODY" "id")

# ───── 3. Mandate validation ─────
echo
note "=== 3. Mandate validation ==="

# 3a. Missing customerId → 400
api_post "/api/v1/payments/mandates" \
  "{\"companyId\":\"$COMPANY_ID\",\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"X\"}"
assert_status "400" "missing customerId → 400"

# 3b. Bad IBAN (no DE prefix) → 400
api_post "/api/v1/payments/mandates" \
  "{\"companyId\":\"$COMPANY_ID\",\"customerId\":\"$CUST_ID\",\"dateOfSignature\":\"2026-07-20\",\"iban\":\"1234\",\"debitorName\":\"X\"}"
assert_status "400" "bad IBAN → 400"

# 3c. Bad date → 400
api_post "/api/v1/payments/mandates" \
  "{\"companyId\":\"$COMPANY_ID\",\"customerId\":\"$CUST_ID\",\"dateOfSignature\":\"not-a-date\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"X\"}"
assert_status "400" "bad dateOfSignature → 400"

# 3d. Unknown customer → 404
api_post "/api/v1/payments/mandates" \
  "{\"companyId\":\"$COMPANY_ID\",\"customerId\":\"00000000-0000-0000-0000-000000000000\",\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"X\"}"
assert_status "404" "unknown customer → 404"

# 3e. Missing companyId → 400
api_post "/api/v1/payments/mandates" \
  "{\"customerId\":\"$CUST_ID\",\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"X\"}"
assert_status "400" "missing companyId → 400"

# ───── 4. Open invoices: customer without mandate excluded ─────
echo
note "=== 4. Open invoices (eligible for direct debit) ==="

# 4a. The customer now has 1 active mandate (re-created in 2e),
#     so the open-invoices list should show all 3 of our invoices.
api_get "/api/v1/payments/direct-debit/open?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/direct-debit/open"
OPEN_COUNT=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([i for i in d if i.get('customerId') == '$CUST_ID']))")
assert_eq "open invoices for our customer" "$OPEN_COUNT" "3"

# 4b. The open-invoice rows must carry mandate metadata
HAS_MANDATE=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine=[i for i in d if i.get('customerId') == '$CUST_ID']
all_ok = all(i.get('mandateId') and i.get('mandateReference') and i.get('iban') for i in mine)
print('True' if all_ok else 'False')
")
assert_eq "all open-invoice rows have mandate metadata" "$HAS_MANDATE" "True"

# 4c. Revoke the mandate; open-invoices should now exclude our customer.
#     (This is the "customer without mandate excluded" test.)
api_delete "/api/v1/payments/mandates/$MANDATE_ID?companyId=$COMPANY_ID&reason=exclude+test" "" >/dev/null
assert_status "200" "revoke mandate to test exclusion"
api_get "/api/v1/payments/direct-debit/open?companyId=$COMPANY_ID"
EXCLUDED=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([i for i in d if i.get('customerId') == '$CUST_ID']))")
assert_eq "open invoices after mandate revoked" "$EXCLUDED" "0"

# 4d. Re-create active mandate
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013000\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde GmbH\"
  }"
assert_status "201" "re-create active mandate"
MANDATE_ID=$(json_field "$BODY" "id")

# ───── 5. Batch generation ─────
echo
note "=== 5. Batch generation (CORE, 2 invoices) ==="
EXEC_DATE="2026-08-01"
COLLECTIONS=$(python3 -c "
import json
print(json.dumps([
  {'invoiceId': '${INV_IDS[0]}', 'mandateId': '$MANDATE_ID'},
  {'invoiceId': '${INV_IDS[1]}', 'mandateId': '$MANDATE_ID'}
]))
")
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": $COLLECTIONS,
    \"executionDate\": \"$EXEC_DATE\",
    \"notes\": \"$PREFIX test batch\"
  }"
assert_status "201" "create CORE batch"
BATCH_ID=$(json_field "$BODY" "id")
BATCH_COUNT=$(json_field "$BODY" "collectionCount")
BATCH_TOTAL=$(json_field "$BODY" "totalAmount")
BATCH_TYPE=$(json_field "$BODY" "type")
BATCH_STATUS=$(json_field "$BODY" "status")
CREDITOR_ID=$(json_field "$BODY" "creditorIdentifier")
[[ -n "$BATCH_ID" ]] && pass "batch id = $BATCH_ID" || fail "no batch id"
assert_eq "batch collectionCount" "$BATCH_COUNT" "2"
assert_eq "batch totalAmount" "$BATCH_TOTAL" "$EXPECTED_BATCH_TOTAL"
assert_eq "batch type" "$BATCH_TYPE" "CORE"
assert_eq "batch status" "$BATCH_STATUS" "generated"
# Gläubiger-ID: 18 chars (DE + 2 check + 8 Geschäftsbereich + 5 Register + 1 filler)
if [[ "${#CREDITOR_ID}" -ge 18 ]]; then
  pass "creditorIdentifier length: ${#CREDITOR_ID} chars (>= 18) ✓"
else
  fail "creditorIdentifier too short: $CREDITOR_ID (${#CREDITOR_ID} chars)"
fi

# ───── 6. XML structure ─────
echo
note "=== 6. XML structure: pain.008.001.02 ==="
# Pull the batch detail to get xmlContent
api_get "/api/v1/payments/direct-debit/batches/$BATCH_ID?companyId=$COMPANY_ID"
assert_status "200" "GET batch detail"
# Save the XML for grep checks
echo "$BODY" > /tmp/tier112-batch.json
XML=$(python3 -c "import json; print(json.load(open('/tmp/tier112-batch.json')).get('xmlContent',''))")

# Write the XML to a file for direct inspection
echo "$XML" > /tmp/tier112-batch.xml

# 6a. Namespace
if echo "$XML" | grep -q 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.02'; then
  pass "namespace pain.008.001.02 ✓"
else
  fail "missing pain.008.001.02 namespace"
fi

# 6b. GrpHdr
if echo "$XML" | grep -q '<GrpHdr>' && echo "$XML" | grep -q '<CstmrDrctDbtInitn>'; then
  pass "CstmrDrctDbtInitn + GrpHdr ✓"
else
  fail "missing CstmrDrctDbtInitn / GrpHdr"
fi

# 6c. PmtMtd = DD
if echo "$XML" | grep -q '<PmtMtd>DD</PmtMtd>'; then
  pass "PmtMtd = DD ✓"
else
  fail "PmtMtd not DD"
fi

# 6d. LclInstrm / Cd = CORE (whitespace-tolerant via python)
LCL_CORE=$(echo "$XML" | python3 -c "
import re,sys
xml=sys.stdin.read()
m=re.search(r'<LclInstrm>\s*<Cd>(CORE|B2B)</Cd>\s*</LclInstrm>', xml)
print(m.group(1) if m else 'NONE')
")
assert_eq "LclInstrm / Cd" "$LCL_CORE" "CORE"

# 6e. CdtrSchmeId (creditor scheme ID) present
if echo "$XML" | grep -q '<CdtrSchmeId>'; then
  pass "CdtrSchmeId present ✓"
else
  fail "missing CdtrSchmeId"
fi

# 6f. Two DrctDbtTxInf blocks
TX_COUNT=$(echo "$XML" | grep -c '<DrctDbtTxInf>')
assert_eq "DrctDbtTxInf count" "$TX_COUNT" "2"

# 6g. Each DrctDbtTxInf has MndtId + DtOfSgntr
MANDATE_IDS_IN_XML=$(echo "$XML" | grep -c '<MndtId>')
assert_eq "MndtId count (one per DrctDbtTxInf)" "$MANDATE_IDS_IN_XML" "2"
SIG_DATES=$(echo "$XML" | grep -c '<DtOfSgntr>2026-07-20</DtOfSgntr>')
assert_eq "DtOfSgntr 2026-07-20 count" "$SIG_DATES" "2"

# 6h. Cdtr (creditor = us) present + Debitor names
if echo "$XML" | grep -q '<Cdtr>'; then
  pass "Cdtr element present ✓"
else
  fail "missing Cdtr element"
fi
if echo "$XML" | grep -q "$PREFIX-Kunde GmbH"; then
  pass "debitorName in XML ✓"
else
  fail "debitorName not in XML"
fi

# ───── 7. Math identity: CtrlSum = Σ DrctDbtTxInf.InstdAmt ─────
echo
note "=== 7. Math identity: CtrlSum = Σ DrctDbtTxInf.InstdAmt ==="
CTRL_SUM=$(echo "$XML" | python3 -c "
import re, sys
xml = sys.stdin.read()
m = re.search(r'<CtrlSum>([0-9.]+)</CtrlSum>', xml)
print(m.group(1) if m else '0')
")
SUM_TX=$(echo "$XML" | python3 -c "
import re, sys
xml = sys.stdin.read()
amts = re.findall(r'<InstdAmt[^>]*>([0-9.]+)</InstdAmt>', xml)
print(f'{sum(float(a) for a in amts):.2f}')
")
assert_eq "CtrlSum === Σ InstdAmt" "$CTRL_SUM" "$SUM_TX"

# NbOfTxs = number of transactions
NB_OF_TXS=$(echo "$XML" | python3 -c "
import re, sys
xml = sys.stdin.read()
m = re.search(r'<NbOfTxs>([0-9]+)</NbOfTxs>', xml)
print(m.group(1) if m else '0')
")
assert_eq "NbOfTxs" "$NB_OF_TXS" "2"

# ───── 8. B2B mandate: separate flow, 1-day pre-notif deadline ─────
echo
note "=== 8. B2B mandate: 1-day pre-notif deadline ==="
# Create a 4th invoice for a separate B2B customer
api_post "/api/v1/customers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-B2B-Kunde\",
    \"type\": \"business\",
    \"address\": {\"street\":\"B2Bstr 2\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},
    \"contact\": {\"email\":\"${PREFIX}-b2b@example.com\"}
  }"
assert_status "201" "create B2B customer"
B2B_CUST_ID=$(json_field "$BODY" "id")

api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$B2B_CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"B2B\",
    \"iban\": \"DE89370400440532013999\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-B2B-Kunde AG\"
  }"
assert_status "201" "create B2B mandate"
B2B_MANDATE_ID=$(json_field "$BODY" "id")
B2B_MANDATE_TYPE=$(json_field "$BODY" "type")
assert_eq "B2B mandate type" "$B2B_MANDATE_TYPE" "B2B"

# Create a B2B-eligible invoice
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{
    \"customerId\": \"$B2B_CUST_ID\",
    \"issueDate\": \"2026-07-01\",
    \"dueDate\": \"2026-07-15\",
    \"items\": [{\"description\":\"$PREFIX B2B item\",\"quantity\":1,\"unitPrice\":1000,\"vatRate\":0.19}]
  }"
assert_status "201" "create B2B invoice"
B2B_INV_ID=$(json_field "$BODY" "id")
api_put "/api/v1/invoices/$B2B_INV_ID/status?companyId=$COMPANY_ID" '{"status":"sent"}'
assert_status "200" "B2B invoice → sent"

# Generate a B2B batch
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": [{\"invoiceId\":\"$B2B_INV_ID\",\"mandateId\":\"$B2B_MANDATE_ID\"}],
    \"executionDate\": \"2026-07-25\",
    \"type\": \"B2B\",
    \"notes\": \"$PREFIX B2B batch\"
  }"
assert_status "201" "create B2B batch"
B2B_BATCH_ID=$(json_field "$BODY" "id")
B2B_BATCH_TYPE=$(json_field "$BODY" "type")
assert_eq "B2B batch type" "$B2B_BATCH_TYPE" "B2B"

# Verify the B2B XML has LclInstrm/Cd = B2B
api_get "/api/v1/payments/direct-debit/batches/$B2B_BATCH_ID?companyId=$COMPANY_ID"
# Re-save to a different file so the python re-read sees the B2B XML
echo "$BODY" > /tmp/tier112-batch-b2b.json
B2B_XML=$(python3 -c "import json; print(json.load(open('/tmp/tier112-batch-b2b.json')).get('xmlContent',''))")
B2B_LCL=$(echo "$B2B_XML" | python3 -c "
import re,sys
xml=sys.stdin.read()
m=re.search(r'<LclInstrm>\s*<Cd>(CORE|B2B)</Cd>\s*</LclInstrm>', xml)
print(m.group(1) if m else 'NONE')
")
assert_eq "B2B batch XML LclInstrm" "$B2B_LCL" "B2B"

# Verify the B2B collection's pre-notification deadline is executionDate - 1 day
DEADLINE_B2B=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT \"preNotificationDeadline\"::date FROM \"SepaDirectDebitCollection\" WHERE \"batchId\" = '$B2B_BATCH_ID' LIMIT 1")
EXPECTED_B2B_DEADLINE="2026-07-24"  # 2026-07-25 - 1 day
assert_eq "B2B pre-notif deadline (execDate - 1)" "$DEADLINE_B2B" "$EXPECTED_B2B_DEADLINE"

# ───── 9. Validation errors ─────
echo
note "=== 9. Batch validation errors ==="

# 9a. Empty collections
api_post "/api/v1/payments/direct-debit/batches" \
  "{\"companyId\":\"$COMPANY_ID\",\"collections\":[],\"executionDate\":\"$EXEC_DATE\"}"
assert_status "400" "empty collections → 400"

# 9b. Bad date
api_post "/api/v1/payments/direct-debit/batches" \
  "{\"companyId\":\"$COMPANY_ID\",\"collections\":[{\"invoiceId\":\"$B2B_INV_ID\",\"mandateId\":\"$B2B_MANDATE_ID\"}],\"executionDate\":\"not-a-date\"}"
assert_status "400" "bad executionDate → 400"

# 9c. Missing companyId
api_post "/api/v1/payments/direct-debit/batches" \
  "{\"collections\":[{\"invoiceId\":\"$B2B_INV_ID\",\"mandateId\":\"$B2B_MANDATE_ID\"}],\"executionDate\":\"$EXEC_DATE\"}"
assert_status "400" "missing companyId → 400"

# 9d. Mixed CORE + B2B in one batch → 400 (§2.2 Scheme Rulebook)
# INV-1 (CORE customer) + B2B_INV_ID (B2B customer) in one batch
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": [
      {\"invoiceId\":\"${INV_IDS[2]}\",\"mandateId\":\"$MANDATE_ID\"},
      {\"invoiceId\":\"$B2B_INV_ID\",\"mandateId\":\"$B2B_MANDATE_ID\"}
    ],
    \"executionDate\": \"$EXEC_DATE\",
    \"type\": \"CORE\"
  }"
assert_status "400" "mixed CORE+B2B → 400"

# 9e. Bad invoice ID
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": [{\"invoiceId\":\"00000000-0000-0000-0000-000000000000\",\"mandateId\":\"$MANDATE_ID\"}],
    \"executionDate\": \"$EXEC_DATE\"
  }"
assert_status "400" "bad invoiceId → 400"

# ───── 10. Invoice collectedBySepaBatchId + excluded from open ─────
echo
note "=== 10. Invoice marked collected, excluded from open ==="
api_get "/api/v1/invoices/${INV_IDS[0]}?companyId=$COMPANY_ID"
COLLECTED_BY=$(json_field "$BODY" "collectedBySepaBatchId")
assert_eq "INV-1 collectedBySepaBatchId" "$COLLECTED_BY" "$BATCH_ID"

api_get "/api/v1/payments/direct-debit/open?companyId=$COMPANY_ID"
REMAINING=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [i for i in d if i.get('customerId') == '$CUST_ID']
print(len(mine))
")
assert_eq "open invoices for CORE customer after batch" "$REMAINING" "1"
# INV-3 should be the remaining one
REMAINING_INV=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [i for i in d if i.get('customerId') == '$CUST_ID']
print(mine[0]['id'] if mine else 'NONE')
")
assert_eq "remaining invoice id" "$REMAINING_INV" "${INV_IDS[2]}"

# ───── 11. Cross-tenant: no x-user-id → 401 ─────
echo
note "=== 11. Cross-tenant guard ==="
# 11a. Direct-debit endpoints
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/payments/direct-debit/open?companyId=$COMPANY_ID")
assert_eq "GET /direct-debit/open no-auth" "$STATUS" "401"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  "$API/api/v1/payments/direct-debit/batches" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"collections\":[],\"executionDate\":\"$EXEC_DATE\"}")
assert_eq "POST /direct-debit/batches no-auth" "$STATUS" "401"
# 11b. Mandate endpoints
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/payments/mandates?companyId=$COMPANY_ID")
assert_eq "GET /mandates no-auth" "$STATUS" "401"

# ───── 12. XML download (Content-Disposition + magic bytes) ─────
echo
note "=== 12. XML download ==="
TMPDIR=$(mktemp -d)
XML_PATH="$TMPDIR/lastschrift.xml"
HEAD_PATH="$TMPDIR/lastschrift.hdr"
STATUS=$(curl -sS -o "$XML_PATH" -D "$HEAD_PATH" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/payments/direct-debit/batches/$BATCH_ID/xml?companyId=$COMPANY_ID")
assert_eq "GET batch XML HTTP status" "$STATUS" "200"
HEAD=$(head -c 5 "$XML_PATH" | tr -d '\0')
assert_eq "XML magic header" "$HEAD" "<?xml"
# Content-Disposition: attachment
if grep -i "Content-Disposition" "$HEAD_PATH" | grep -q "attachment"; then
  pass "Content-Disposition: attachment ✓"
else
  fail "Content-Disposition not attachment"
fi
# Filename contains the batch id
if grep -i "Content-Disposition" "$HEAD_PATH" | grep -q "$BATCH_ID"; then
  pass "filename contains batch id ✓"
else
  fail "filename does not contain batch id"
fi

# ───── 13. Revoked mandate cannot be used in new batch → 400 ─────
echo
note "=== 13. Revoked mandate cannot be used ==="
# Create a new mandate, revoke it, try to use it
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013888\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde GmbH\"
  }"
assert_status "201" "create mandate to revoke"
REVOKED_MANDATE_ID=$(json_field "$BODY" "id")
api_delete "/api/v1/payments/mandates/$REVOKED_MANDATE_ID?companyId=$COMPANY_ID" "" >/dev/null
assert_status "200" "revoke mandate"
# Create a fresh invoice for the test (since INV-3 is still open and would
# be picked up)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{
    \"customerId\": \"$CUST_ID\",
    \"issueDate\": \"2026-07-01\",
    \"dueDate\": \"2026-07-15\",
    \"items\": [{\"description\":\"revoked test\",\"quantity\":1,\"unitPrice\":50,\"vatRate\":0.19}]
  }"
assert_status "201" "create invoice for revoked test"
REV_INV_ID=$(json_field "$BODY" "id")
api_put "/api/v1/invoices/$REV_INV_ID/status?companyId=$COMPANY_ID" '{"status":"sent"}'
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": [{\"invoiceId\":\"$REV_INV_ID\",\"mandateId\":\"$REVOKED_MANDATE_ID\"}],
    \"executionDate\": \"2026-08-15\"
  }"
assert_status "400" "revoked mandate → 400"

# ───── 14. Mismatched mandate (wrong customer) → 400 ─────
echo
note "=== 14. Mismatched mandate (wrong customer) ==="
# Create a 2nd customer + 2nd mandate, then try to use the 2nd mandate
# on the 1st customer's invoice
api_post "/api/v1/customers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-Kunde2\",
    \"type\": \"business\",
    \"address\": {\"street\":\"K2 1\",\"postalCode\":\"50667\",\"city\":\"Köln\",\"country\":\"DE\"},
    \"contact\": {\"email\":\"${PREFIX}-k2@example.com\"}
  }"
assert_status "201" "create 2nd customer"
K2_CUST_ID=$(json_field "$BODY" "id")
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$K2_CUST_ID\",
    \"dateOfSignature\": \"2026-07-20\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013777\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde2 GmbH\"
  }"
assert_status "201" "create mandate for K2"
K2_MANDATE_ID=$(json_field "$BODY" "id")
# Try to use K2's mandate on CUST's invoice
api_post "/api/v1/payments/direct-debit/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"collections\": [{\"invoiceId\":\"$REV_INV_ID\",\"mandateId\":\"$K2_MANDATE_ID\"}],
    \"executionDate\": \"2026-08-15\"
  }"
assert_status "400" "mismatched mandate → 400"

# ───── 15. Two mandates for same customer, both active ─────
echo
note "=== 15. Two mandates for same customer ==="
# Create a 2nd mandate for our CUST_ID — should coexist
api_post "/api/v1/payments/mandates" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"customerId\": \"$CUST_ID\",
    \"dateOfSignature\": \"2026-07-22\",
    \"type\": \"CORE\",
    \"iban\": \"DE89370400440532013666\",
    \"bic\": \"COBADEFFXXX\",
    \"debitorName\": \"$PREFIX-Kunde GmbH\",
    \"description\": \"2. Mandat für Abos\"
  }"
assert_status "201" "create 2nd mandate for same customer"
SECOND_MANDATE_ID=$(json_field "$BODY" "id")
api_get "/api/v1/payments/mandates?companyId=$COMPANY_ID"
TWO_MANDATES=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [m for m in d if m.get('customerId') == '$CUST_ID' and m.get('status') == 'active']
print(len(mine))
")
assert_eq "active mandates for CUST_ID" "$TWO_MANDATES" "2"
# Open-invoices should auto-select the most-recent mandate
api_get "/api/v1/payments/direct-debit/open?companyId=$COMPANY_ID"
SELECTED_MANDATE=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [i for i in d if i.get('customerId') == '$CUST_ID']
print(mine[0]['mandateId'] if mine else 'NONE')
")
assert_eq "auto-selected mandate (most recent)" "$SELECTED_MANDATE" "$SECOND_MANDATE_ID"

# ───── 16. List batches ─────
echo
note "=== 16. List batches ==="
api_get "/api/v1/payments/direct-debit/batches?companyId=$COMPANY_ID"
assert_status "200" "GET /direct-debit/batches"
BATCH_LIST_COUNT=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [b for b in d if b.get('notes','').startswith('$PREFIX')]
print(len(mine))
")
# We have 2 batches (CORE for INV-1+2, B2B for B2B_INV). Plus 0
# failed (the mixed-type attempt + revoked-mandate attempt both 400'd).
assert_eq "batch list count for prefix" "$BATCH_LIST_COUNT" "2"

# ───── 17. Cleanup ─────
echo
note "=== 17. Cleanup ==="
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "SepaDirectDebitCollection" WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "SepaDirectDebitBatch"     WHERE "companyId" = '$COMPANY_ID'
  AND "notes" LIKE '${PREFIX}%';
DELETE FROM "SepaDirectDebitMandate"   WHERE "companyId" = '$COMPANY_ID'
  AND ("mandateReference" LIKE 'MANDATE-${PREFIX}%'
    OR "description" LIKE '${PREFIX}%'
    OR "debitorName" LIKE '${PREFIX}%');
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "customerId" IN (
    SELECT id FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%'
  )
);
DELETE FROM "Invoice" WHERE "customerId" IN (
  SELECT id FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%'
);
DELETE FROM "Customer"    WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE '${PREFIX}%';
SQL
pass "cleanup complete"

# Confirm post-cleanup state
api_get "/api/v1/payments/direct-debit/batches?companyId=$COMPANY_ID"
POST_CLEAN=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [b for b in d if b.get('notes','').startswith('$PREFIX')]
print(len(mine))
")
assert_eq "batches after cleanup" "$POST_CLEAN" "0"

api_get "/api/v1/payments/mandates?companyId=$COMPANY_ID"
POST_CLEAN_MANDATES=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine = [m for m in d if m.get('customerId') == '$CUST_ID']
print(len(mine))
")
assert_eq "mandates after cleanup" "$POST_CLEAN_MANDATES" "0"

summary "Tier 112"
exit $?
