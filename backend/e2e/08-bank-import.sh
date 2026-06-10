#!/bin/bash
# Test 08: Bank import (MT940 + CAMT.053).
# - parse the sample MT940 file and verify the
#   resulting BankStatement + BankTransaction rows
# - create a matching open invoice
# - call the candidates endpoint and assert the match
#   score

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# Cleanup any prior test data
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-E2E';" >/dev/null 2>&1

echo "=== Test: bank import MT940 + candidate matching ==="

# Build the sample MT940 file
cat > /tmp/e2e.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST20260609001
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR1234,56
:61:2606020602C200,00NTRFNONREF//Gehalt
Frau Müller
Lohn/Gehalt 06/2026
:62F:C260603EUR1434,56
-
EOF

# Upload via curl -- the controller takes multipart form.
# We use -F file=@... with a Content-Type so the file
# gets read as bytes.
UPLOAD=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID=$(json_field "$UPLOAD" id)
# Use a simpler check — was the upload successful?
if [[ -z "$SID" || "$SID" == "null" ]]; then
  fail "Upload failed: $UPLOAD"
  summary
  exit 1
fi
pass "MT940 uploaded, statement id: ${SID:0:8}..."

# Verify statement metadata
api_get "/api/v1/bank-statements?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
assert_eq "statement count" "$COUNT" "1"

api_get "/api/v1/bank-statements/$SID?companyId=$COMPANY_ID"
FMT=$(json_field "$BODY" format)
assert_eq "format" "$FMT" "mt940"
IBAN=$(json_field "$BODY" accountIban)
assert_eq "IBAN" "$IBAN" "DE89370400440532013000"
OPEN=$(json_field "$BODY" openingBalance)
CLOSE=$(json_field "$BODY" closingBalance)
assert_eq "opening balance" "$OPEN" "1234.56"
assert_eq "closing balance" "$CLOSE" "1434.56"

# Verify transactions
TXN_COUNT=$(echo "$BODY" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['transactions']))")
assert_eq "transaction count" "$TXN_COUNT" "1"

# Check the +200 transaction
TXN_AMT=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactions'][0]['amount'])")
assert_eq "transaction amount" "$TXN_AMT" "200"
TXN_CCY=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactions'][0]['currency'])")
assert_eq "transaction currency" "$TXN_CCY" "EUR"

# Get the +200 transaction id
TXN_ID=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['transactions'][0]['id'])")

# Create a matching open invoice
CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"createdAt\", \"updatedAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 'INV-2026-TEST-E2E', 'INV', 'sent', '2026-06-02', '2026-06-09', 168.07, 31.93, 200.00, 'EUR', 'de-DE', now(), now());" >/dev/null 2>&1

# Verify the invoice exists
INV_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-E2E';" 2>/dev/null | tr -d ' ')
assert_eq "test invoice created" "$INV_COUNT" "1"

# Now call the candidates endpoint
api_get "/api/v1/bank-statements/$SID/transactions/$TXN_ID/candidates?companyId=$COMPANY_ID"
# getCandidates returns { transaction, candidates: [...] }
CAND_BODY=$(echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(json.dumps(d.get('candidates', d)))
")
CAND_COUNT=$(echo "$CAND_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
# Filter to ones with confidence >= 30 (that's the
# minimum the service returns)
print(len([c for c in d if c['confidence'] >= 30]))
")
note "candidate count (≥30): $CAND_COUNT"

# The exact match invoice (amount + date) should be
# the top candidate with confidence 80
TOP_INV=$(echo "$CAND_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if d:
    print(d[0].get('invoiceNumber', ''))
")
assert_eq "top candidate invoice" "$TOP_INV" "INV-2026-TEST-E2E"

TOP_CONF=$(echo "$CAND_BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if d:
    print(d[0].get('confidence', 0))
")
assert_eq "top candidate confidence (60 amount + 20 date = 80)" "$TOP_CONF" "80"

# Auto-generate suggestions
api_post "/api/v1/bank-statements/$SID/suggest?companyId=$COMPANY_ID" ""
assert_status "201" "auto-suggest"

# Verify a BankReconciliation row was created
RECON_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"BankReconciliation\" WHERE \"bankTransactionId\" = '$TXN_ID';" 2>/dev/null | tr -d ' ')
assert_eq "reconciliation created" "$RECON_COUNT" "1"

# Re-running suggest is idempotent (skips already-matched)
api_post "/api/v1/bank-statements/$SID/suggest?companyId=$COMPANY_ID" ""
RECON_COUNT_2=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"BankReconciliation\" WHERE \"bankTransactionId\" = '$TXN_ID';" 2>/dev/null | tr -d ' ')
assert_eq "re-ran suggest is idempotent" "$RECON_COUNT_2" "1"

# CAMT.053 round-trip: upload a sample XML and verify
# the same shape.
cat > /tmp/e2e.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<Document>
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
      <Bal type="OPBD"><Amt>100.00</Amt><Ccy>EUR</Ccy><Dt>2026-06-01</Dt></Bal>
      <Bal type="CLBD"><Amt>300.00</Amt><Ccy>EUR</Ccy><Dt>2026-06-30</Dt></Bal>
      <Ntry>
        <Amt>200.00</Amt><Ccy>EUR</Ccy><CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-06-15</Dt></BookgDt>
        <ValDt><Dt>2026-06-15</Dt></ValDt>
        <TxDtls>
          <CdtTrxTxInf>
            <PmtId><EndToEndId>E2E-001</EndToEndId></PmtId>
            <RmtInf><Ustrd>Rechnung INV-2026-TEST-E2E</Ustrd></RmtInf>
            <Dbtr><Nm>Frau Müller</Nm></Dbtr>
            <DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>
          </CdtTrxTxInf>
        </TxDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
EOF
UPLOAD2=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e.xml;type=application/xml" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID2=$(json_field "$UPLOAD2" id)
if [[ -z "$SID2" || "$SID2" == "null" ]]; then
  fail "CAMT.053 upload failed: $UPLOAD2"
else
  pass "CAMT.053 uploaded, statement id: ${SID2:0:8}..."
  FMT2=$(json_field "$UPLOAD2" format)
  assert_eq "CAMT format" "$FMT2" "camt053"
  # Find the +200 transaction (purpose has 'INV-2026-TEST-E2E' — purpose match adds 25)
  TXN_ID2=$(echo "$UPLOAD2" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for t in d['transactions']:
    if float(t['amount']) == 200: print(t['id']); break
")
  api_get "/api/v1/bank-statements/$SID2/transactions/$TXN_ID2/candidates?companyId=$COMPANY_ID"
  CAND_BODY2=$(echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(json.dumps(d.get('candidates', d)))
")
  TOP_CONF2=$(echo "$CAND_BODY2" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if d: print(d[0].get('confidence', 0))
")
  # 60 (amount) + ? (date, valueDate=6/15 vs dueDate=6/9 → 6 days → ±7d = 20) + 25 (purpose match) = 105 → capped at 100
  # But actually the purpose contains the invoice number, so we expect 100 (capped)
  if [[ "$TOP_CONF2" -ge 95 ]]; then
    pass "CAMT candidate confidence with purpose match (≥95, got $TOP_CONF2)"
  else
    fail "CAMT candidate confidence too low: $TOP_CONF2 (expected ≥95 with purpose match)"
  fi
fi

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-E2E';" >/dev/null 2>&1

summary
