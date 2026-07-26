#!/usr/bin/env bash
# Tier 108 — SEPA pain.001 batch payments
# (Sammelüberweisung, ISO 20022 pain.001.001.09).
#
# Validates the new payments flow:
#   - GET  /payments/unpaid            list open payables
#   - GET  /payments/batches           list past batches
#   - POST /payments/batches           create a new batch
#   - GET  /payments/batches/:id       get one batch
#   - GET  /payments/batches/:id/xml   download pain.001 XML
#
# The test creates 1 supplier with IBAN + 3 unpaid
# expenses, runs the full flow, then asserts:
#   - Unpaid list contains 3
#   - Batch creation marks them paid
#   - XML is well-formed + pain.001.001.09
#   - Math identity: CtrlSum = sum(CdtTrfTxInf.InstdAmt)
#   - Idempotency: re-creating with same IDs → 400
#   - Validation: empty / bad date → 400
#   - Cross-tenant: no x-user-id → 401

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)
PREFIX="Tier108-$TS"

note "=== Test prefix: $PREFIX ==="

# ===== 0. Setup: create a supplier with IBAN + 3 unpaid expenses =====
echo
note "=== 0. Setup: supplier + 3 expenses ==="

api_post "/api/v1/suppliers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-Lieferant\",
    \"address\": {\"street\": \"Musterstr. 1\", \"zip\": \"50667\", \"city\": \"Köln\"},
    \"bankInfo\": {\"iban\": \"DE89370400440532013000\", \"bic\": \"COBADEFFXXX\", \"kontoinhaber\": \"$PREFIX-Lieferant GmbH\"}
  }"
assert_status "201" "create supplier with IBAN"
SUPPLIER_ID=$(json_field "$BODY" "id")
test -n "$SUPPLIER_ID" && pass "supplier id = $SUPPLIER_ID" || fail "no supplier id"

# Create 3 unpaid expenses tied to that supplier
declare -a EXPENSE_IDS=()
for i in 1 2 3; do
  AMT_NET=$((100 * i))      # 100, 200, 300
  AMT_VAT=$((19 * i))       # 19% MwSt
  AMT_GROSS=$((AMT_NET + AMT_VAT))
  api_post "/api/v1/expenses?companyId=$COMPANY_ID" \
    "{
      \"supplierId\": \"$SUPPLIER_ID\",
      \"invoiceNumber\": \"$PREFIX-RE-$i\",
      \"description\": \"Material $i\",
      \"invoiceDate\": \"2026-07-01\",
      \"netAmount\": $AMT_NET,
      \"vatRate\": 0.19,
      \"vatAmount\": $AMT_VAT,
      \"grossAmount\": $AMT_GROSS,
      \"status\": \"booked\"
    }"
  assert_status "201" "create expense $i ($AMT_GROSS € gross)"
  EID=$(json_field "$BODY" "id")
  test -n "$EID" && pass "  expense $i id = $EID" || fail "  no expense id"
  EXPENSE_IDS+=("$EID")
done

# Expected total = 119 + 238 + 357 = 714 EUR
EXPECTED_TOTAL="714.00"

# ===== 1. GET /payments/unpaid returns 3 expenses =====
echo
note "=== 1. GET /payments/unpaid returns 3 expenses ==="
api_get "/api/v1/payments/unpaid?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/unpaid"
UNPAID_COUNT=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([e for e in d if e.get('supplier',{}).get('name','').startswith('$PREFIX')]))")
assert_eq "unpaid count for prefix" "$UNPAID_COUNT" "3"

# Verify each unpaid row has IBAN
ALL_HAVE_IBAN=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
mine=[e for e in d if e.get('supplier',{}).get('name','').startswith('$PREFIX')]
all_ok = all((e.get('supplier') or {}).get('bankInfo',{}).get('iban') for e in mine)
print('True' if all_ok else 'False')
")
assert_eq "all 3 rows have IBAN" "$ALL_HAVE_IBAN" "True"

# ===== 2. GET /payments/batches returns 0 batches for prefix =====
echo
note "=== 2. GET /payments/batches ==="
api_get "/api/v1/payments/batches?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/batches"
BATCH_COUNT_BEFORE=$(echo "$BODY" | python3 -c "import json,sys; print(len([b for b in json.load(sys.stdin) if b.get('debtorName','').startswith('$PREFIX') or '$PREFIX' in (b.get('notes') or '')]))")
# Pre-existing batches from previous runs may exist; this test is additive.
note "  existing batches for prefix before: $BATCH_COUNT_BEFORE"

# ===== 3. POST /payments/batches creates a new batch =====
echo
note "=== 3. POST /payments/batches creates new batch ==="
EXEC_DATE="2026-07-30"
api_post "/api/v1/payments/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"expenseIds\": [\"${EXPENSE_IDS[0]}\", \"${EXPENSE_IDS[1]}\", \"${EXPENSE_IDS[2]}\"],
    \"executionDate\": \"$EXEC_DATE\",
    \"notes\": \"$PREFIX-batch\"
  }"
assert_status "201" "POST /payments/batches"
BATCH_ID=$(json_field "$BODY" "id")
PAYMENT_COUNT=$(json_field "$BODY" "paymentCount")
TOTAL_AMOUNT=$(json_field "$BODY" "totalAmount")
test -n "$BATCH_ID" && pass "batch id = $BATCH_ID" || fail "no batch id"
assert_eq "paymentCount" "$PAYMENT_COUNT" "3"
assert_close "totalAmount" "$TOTAL_AMOUNT" "$EXPECTED_TOTAL"

# ===== 4. GET /payments/unpaid no longer returns these 3 =====
echo
note "=== 4. Unpaid list now empty for prefix ==="
api_get "/api/v1/payments/unpaid?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/unpaid after batch"
UNPAID_AFTER=$(echo "$BODY" | python3 -c "import json,sys; print(len([e for e in json.load(sys.stdin) if e.get('supplier',{}).get('name','').startswith('$PREFIX')]))")
assert_eq "unpaid count after batch" "$UNPAID_AFTER" "0"

# ===== 5. GET /payments/batches now contains the new batch =====
echo
note "=== 5. GET /payments/batches contains new batch ==="
api_get "/api/v1/payments/batches?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/batches after create"
FOUND=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
hit = any(b.get('id')=='$BATCH_ID' for b in d)
print('True' if hit else 'False')
")
assert_eq "new batch in list" "$FOUND" "True"

# ===== 6. GET /payments/batches/:id returns the batch =====
echo
note "=== 6. GET /payments/batches/:id ==="
api_get "/api/v1/payments/batches/$BATCH_ID?companyId=$COMPANY_ID"
assert_status "200" "GET /payments/batches/$BATCH_ID"
GOT_ID=$(json_field "$BODY" "id")
assert_eq "batch id matches" "$GOT_ID" "$BATCH_ID"

# ===== 7. GET /payments/batches/:id/xml returns valid pain.001 XML =====
echo
note "=== 7. GET /payments/batches/:id/xml ==="
XML_HEAD=$(curl -sS -o /tmp/pain001-$TS.xml -w "%{http_code}|%{content_type}|%{size_download}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/payments/batches/$BATCH_ID/xml?companyId=$COMPANY_ID")
XML_STATUS=$(echo "$XML_HEAD" | cut -d'|' -f1)
XML_CTYPE=$(echo "$XML_HEAD" | cut -d'|' -f2)
XML_SIZE=$(echo "$XML_HEAD" | cut -d'|' -f3)
assert_eq "XML status 200" "$XML_STATUS" "200"
assert_eq "XML content-type" "$XML_CTYPE" "application/xml; charset=utf-8"
test "$XML_SIZE" -gt 800 && pass "XML size = $XML_SIZE bytes" || fail "XML too small: $XML_SIZE"

# ===== 8. XML is well-formed and pain.001.001.09 =====
echo
note "=== 8. XML is valid pain.001.001.09 ==="
WELLFORMED=$(python3 -c "
import xml.etree.ElementTree as ET
try:
  ET.parse('/tmp/pain001-$TS.xml')
  print('True')
except Exception as e:
  print('False')
")
assert_eq "XML parseable by Python ElementTree" "$WELLFORMED" "True"

NAMESPACE=$(grep -oE 'xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"' /tmp/pain001-$TS.xml | head -1)
test -n "$NAMESPACE" && pass "namespace = pain.001.001.09" || fail "namespace missing"

DOCUMENT=$(grep -c '<Document' /tmp/pain001-$TS.xml || echo 0)
GRP_HDR=$(grep -c '<GrpHdr>' /tmp/pain001-$TS.xml || echo 0)
PMT_INF=$(grep -c '<PmtInf>' /tmp/pain001-$TS.xml || echo 0)
CDT_TRX=$(grep -c '<CdtTrfTxInf>' /tmp/pain001-$TS.xml || echo 0)
test "$DOCUMENT" -ge 1 && pass "Document element present" || fail "no Document"
test "$GRP_HDR" -ge 1 && pass "GrpHdr present" || fail "no GrpHdr"
test "$PMT_INF" -ge 1 && pass "PmtInf present" || fail "no PmtInf"
test "$CDT_TRX" -ge 1 && pass "CdtTrfTxInf present" || fail "no CdtTrfTxInf"

# ===== 9. Pain.001 contains the 3 supplier IBANs =====
echo
note "=== 9. Pain.001 contains the 3 creditor IBANs ==="
for iban in "DE89370400440532013000"; do
  COUNT=$(grep -c "$iban" /tmp/pain001-$TS.xml || echo 0)
  test "$COUNT" -ge 3 && pass "creditor IBAN $iban appears $COUNT times" || fail "creditor IBAN $iban appears only $COUNT times (expected ≥ 3)"
done

# ===== 10. Math identity: CtrlSum = sum of CdtTrfTxInf amounts =====
echo
note "=== 10. Math identity: CtrlSum = Σ amounts ==="
MATH=$(python3 -c "
import re
with open('/tmp/pain001-$TS.xml') as f:
  s = f.read()
ctrl = re.search(r'<CtrlSum>([\d.]+)</CtrlSum>', s)
ctrl_val = float(ctrl.group(1)) if ctrl else 0
amounts = re.findall(r'<InstdAmt[^>]*>([\d.]+)</InstdAmt>', s)
sum_amt = sum(float(a) for a in amounts)
ok = abs(ctrl_val - sum_amt) < 0.01
print(f'{ok}|{ctrl_val}|{sum_amt}|{len(amounts)}')
")
assert_eq "CtrlSum == Σ amounts" "$(echo "$MATH" | cut -d'|' -f1)" "True"
pass "CtrlSum=$(echo "$MATH" | cut -d'|' -f2) Σ=$(echo "$MATH" | cut -d'|' -f3) (txCount=$(echo "$MATH" | cut -d'|' -f4))"

# ===== 11. Re-running with same expenseIds → 400 (already paid) =====
echo
note "=== 11. Re-running with same expenseIds → 400 ==="
api_post "/api/v1/payments/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"expenseIds\": [\"${EXPENSE_IDS[0]}\", \"${EXPENSE_IDS[1]}\", \"${EXPENSE_IDS[2]}\"],
    \"executionDate\": \"$EXEC_DATE\"
  }"
# Expected 400 — expenses are no longer 'booked, paidAt=NULL'
test "$STATUS" = "400" && pass "second batch with paid expenseIds → 400" || fail "second batch → $STATUS (expected 400): $BODY"

# ===== 12. Empty expenseIds → 400 =====
echo
note "=== 12. Empty expenseIds → 400 ==="
api_post "/api/v1/payments/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"expenseIds\": [],
    \"executionDate\": \"$EXEC_DATE\"
  }"
test "$STATUS" = "400" && pass "empty expenseIds → 400" || fail "empty expenseIds → $STATUS (expected 400)"

# ===== 13. Bad executionDate → 400 =====
echo
note "=== 13. Bad executionDate format → 400 ==="
# Create a new supplier + 1 expense for this test
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-2nd\",
    \"address\": {\"street\": \"X\"},
    \"bankInfo\": {\"iban\": \"DE89370400440532013000\"}
  }"
SUP2_ID=$(json_field "$BODY" "id")
api_post "/api/v1/expenses?companyId=$COMPANY_ID" \
  "{
    \"supplierId\": \"$SUP2_ID\",
    \"description\": \"X\",
    \"invoiceDate\": \"2026-07-01\",
    \"netAmount\": 100,
    \"vatAmount\": 19,
    \"grossAmount\": 119,
    \"status\": \"booked\"
  }"
EID_X=$(json_field "$BODY" "id")

api_post "/api/v1/payments/batches" \
  "{
    \"companyId\": \"$COMPANY_ID\",
    \"expenseIds\": [\"$EID_X\"],
    \"executionDate\": \"30.07.2026\"
  }"
test "$STATUS" = "400" && pass "bad executionDate format → 400" || fail "bad date → $STATUS (expected 400): $BODY"

# ===== 14. Cross-tenant: no x-user-id → 401 =====
echo
note "=== 14. Cross-tenant: no x-user-id → 401 ==="
NO_AUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/payments/unpaid?companyId=$COMPANY_ID")
test "$NO_AUTH_STATUS" = "401" && pass "no x-user-id → 401" || fail "no x-user-id → $NO_AUTH_STATUS (expected 401)"

# ===== 15. Missing companyId → 400 =====
echo
note "=== 15. Missing companyId → 400 ==="
api_post "/api/v1/payments/batches" \
  "{
    \"expenseIds\": [\"$EID_X\"],
    \"executionDate\": \"$EXEC_DATE\"
  }"
test "$STATUS" = "400" && pass "missing companyId → 400" || fail "missing companyId → $STATUS (expected 400)"

# ===== 16. XML download sets Content-Disposition =====
echo
note "=== 16. XML download sets Content-Disposition ==="
HEAD_FILE=/tmp/pain001-headers-$TS.txt
curl -sS -o /dev/null -D "$HEAD_FILE" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/payments/batches/$BATCH_ID/xml?companyId=$COMPANY_ID" >/dev/null
DISP=$(grep -i '^content-disposition:' "$HEAD_FILE" 2>&1 | head -1 || echo "")
[[ "$DISP" == *"attachment"* ]] && pass "Content-Disposition = attachment" || fail "no attachment header: $DISP"
FNAME=$(echo "$DISP" | grep -oE 'filename="[^"]+"' | sed 's/^filename="//;s/"$//' || echo "")
assert_eq "filename matches" "$FNAME" "SEPA_${BATCH_ID}.xml"

# ===== 17. Expenses are now linked to the batch in the DB =====
echo
note "=== 17. Expenses linked to batch ==="
LINKED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"Expense\" WHERE \"paidBySepaBatchId\" = '$BATCH_ID';")
assert_eq "expenses linked to batch" "$LINKED" "3"

# ===== 18. Expense paidAt set = executionDate =====
echo
note "=== 18. Expense paidAt set to executionDate ==="
PAID_AT_OK=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT (COUNT(*) = 3)::text FROM \"Expense\" WHERE \"paidBySepaBatchId\" = '$BATCH_ID' AND \"paidAt\" = '$EXEC_DATE'::date;")
assert_eq "paidAt = executionDate for all 3" "$PAID_AT_OK" "true"

# ===== 19. XML <ReqdExctnDt> matches the executionDate =====
echo
note "=== 19. XML <ReqdExctnDt> matches ==="
REQ_DATE=$(grep -oE '<ReqdExctnDt>[^<]+' /tmp/pain001-$TS.xml | head -1 | sed 's/.*>//')
assert_eq "ReqdExctnDt in XML" "$REQ_DATE" "$EXEC_DATE"

# ===== 20. XML has 3 distinct CdtTrfTxInf blocks (one per expense) =====
echo
note "=== 20. XML has 3 CdtTrfTxInf blocks ==="
TX_COUNT=$(grep -c '<CdtTrfTxInf>' /tmp/pain001-$TS.xml || echo 0)
assert_eq "CdtTrfTxInf count" "$TX_COUNT" "3"

# ===== 21. XML <PmtInfId> and <MsgId> present and non-empty =====
echo
note "=== 21. XML identifiers present ==="
MSG_ID=$(grep -oE '<MsgId>[^<]+' /tmp/pain001-$TS.xml | head -1 | sed 's/.*>//')
PMT_INF_ID=$(grep -oE '<PmtInfId>[^<]+' /tmp/pain001-$TS.xml | head -1 | sed 's/.*>//')
test -n "$MSG_ID" && pass "MsgId = $MSG_ID" || fail "no MsgId"
[[ "$PMT_INF_ID" == *"-PMT" ]] && pass "PmtInfId = $PMT_INF_ID" || fail "PmtInfId wrong: $PMT_INF_ID"

# ===== 22. XML has 3 EndToEndId (one per payment) =====
echo
note "=== 22. XML has 3 EndToEndId ==="
E2E_COUNT=$(grep -c '<EndToEndId>' /tmp/pain001-$TS.xml || echo 0)
assert_eq "EndToEndId count" "$E2E_COUNT" "3"

# ===== 23. XML has the BIC (COBADEFFXXX) =====
echo
note "=== 23. XML has the BIC ==="
BIC_COUNT=$(grep -c '<BIC>COBADEFFXXX</BIC>' /tmp/pain001-$TS.xml || echo 0)
test "$BIC_COUNT" -ge 3 && pass "BIC appears $BIC_COUNT times (≥ 3)" || fail "BIC count = $BIC_COUNT (expected ≥ 3)"

# ===== 24. Notes from the POST are persisted in SepaBatch =====
echo
note "=== 24. Notes persisted in SepaBatch ==="
NOTES_PERSISTED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT \"notes\" FROM \"SepaBatch\" WHERE id = '$BATCH_ID';")
assert_eq "notes in SepaBatch" "$NOTES_PERSISTED" "$PREFIX-batch"

# ===== 25. Expense without IBAN supplier not in unpaid list =====
echo
note "=== 25. Expense without supplier IBAN not in unpaid list ==="
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" \
  "{
    \"name\": \"$PREFIX-no-iban\",
    \"address\": {\"street\": \"Y\"}
  }"
SUP_NO_IBAN=$(json_field "$BODY" "id")
api_post "/api/v1/expenses?companyId=$COMPANY_ID" \
  "{
    \"supplierId\": \"$SUP_NO_IBAN\",
    \"description\": \"No IBAN\",
    \"invoiceDate\": \"2026-07-01\",
    \"netAmount\": 50,
    \"vatAmount\": 9.5,
    \"grossAmount\": 59.5,
    \"status\": \"booked\"
  }"
EID_NO_IBAN=$(json_field "$BODY" "id")
api_get "/api/v1/payments/unpaid?companyId=$COMPANY_ID"
HAS_NO_IBAN=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
hit = any(e.get('id')=='$EID_NO_IBAN' for e in d)
print('True' if hit else 'False')
")
assert_eq "expense without IBAN NOT in unpaid" "$HAS_NO_IBAN" "False"

summary "Tier 108 — SEPA pain.001 batch payments"
