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
   DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"companyId\" = '$COMPANY_ID' AND \"referenceType\" IN ('BankReconciliation', 'BankTransaction', 'BankReconciliationReversal'));
   DELETE FROM \"Voucher\" WHERE \"companyId\" = '$COMPANY_ID' AND \"referenceType\" IN ('BankReconciliation', 'BankTransaction', 'BankReconciliationReversal');
   DELETE FROM \"Payment\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" IN ('INV-2026-TEST-E2E', 'INV-2026-TEST-002', 'INV-2026-TEST-003', 'INV-2026-TEST-CAMT', 'INV-2026-TEST-AUTO'));
   DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" IN ('INV-2026-TEST-E2E', 'INV-2026-TEST-002', 'INV-2026-TEST-003', 'INV-2026-TEST-CAMT', 'INV-2026-TEST-AUTO');" >/dev/null 2>&1

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

# === Confirm flow: PaymentService.create() + invoice flips to 'paid' ===
# Grab the suggested recon id
RECON_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"BankReconciliation\" WHERE \"bankTransactionId\" = '$TXN_ID';" 2>/dev/null | tr -d ' ')

# Check invoice status BEFORE confirm
INV_BEFORE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-E2E';" 2>/dev/null | tr -d ' ')
assert_eq "invoice status before confirm" "$INV_BEFORE" "sent"

# Confirm the candidate
api_post "/api/v1/bank-statements/reconciliations/$RECON_ID/confirm?companyId=$COMPANY_ID" ""
assert_status "201" "confirm candidate"
PAY_ID=$(json_field "$BODY" paymentId)
if [[ -z "$PAY_ID" || "$PAY_ID" == "null" ]]; then
  fail "confirm did not return paymentId: $BODY"
else
  pass "confirm returned paymentId: ${PAY_ID:0:8}..."
fi

# Verify invoice flipped to 'paid' and Payment row exists
INV_AFTER=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-E2E';" 2>/dev/null | tr -d ' ')
assert_eq "invoice status after confirm" "$INV_AFTER" "paid"

PAYMENT_AMT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT amount FROM \"Payment\" WHERE id = '$PAY_ID';" 2>/dev/null | tr -d ' ')
assert_eq "payment amount" "$PAYMENT_AMT" "200.0000"

PAY_METHOD=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"paymentMethod\" FROM \"Payment\" WHERE id = '$PAY_ID';" 2>/dev/null | tr -d ' ')
assert_eq "payment method" "$PAY_METHOD" "Überweisung"

RECON_STATUS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE id = '$RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "reconciliation status after confirm" "$RECON_STATUS" "confirmed"

# === GoBD Voucher auto-booking on confirm ===
# The confirm flow should write a double-entry voucher:
#   Debit  1200 Bank              200.00
#   Credit 1406 Forderung L+L     200.00
# (VAT was already booked when the invoice was issued,
# so no USt line is needed.)
VCH_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherId\" FROM \"BankReconciliation\" WHERE id = '$RECON_ID';" 2>/dev/null | tr -d ' ')
if [[ -z "$VCH_ID" || "$VCH_ID" == "" ]]; then
  fail "no voucherId on reconciliation after confirm"
else
  pass "voucher linked: ${VCH_ID:0:8}..."
fi

VCH_NUMBER=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherNumber\" FROM \"Voucher\" WHERE id = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher number pattern" "$(echo $VCH_NUMBER | grep -cE '^BK-[0-9]{4}-[0-9]+$')" "1"

VCH_REFTYPE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"referenceType\" FROM \"Voucher\" WHERE id = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher referenceType" "$VCH_REFTYPE" "BankReconciliation"

VCH_STATUS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Voucher\" WHERE id = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher status" "$VCH_STATUS" "posted"

# 2 voucher lines: Bank 1200 (debit) + Forderung 1406 (credit)
LINE_COUNT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher line count" "$LINE_COUNT" "2"

# Soll = Haben = 200.00
SUM_DEBIT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT SUM(debit) FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher sum debit" "$SUM_DEBIT" "200.0000"
SUM_CREDIT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT SUM(credit) FROM \"VoucherLine\" WHERE \"voucherId\" = '$VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucher sum credit" "$SUM_CREDIT" "200.0000"

# Specific accounts
BANK_LINE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT a.\"accountNumber\" || '|' || vl.debit
   FROM \"VoucherLine\" vl JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE vl.\"voucherId\" = '$VCH_ID' AND vl.debit > 0;" 2>/dev/null | tr -d ' ')
assert_eq "voucher debit line is Bank 1200" "$BANK_LINE" "1200|200.0000"

RECV_LINE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT a.\"accountNumber\" || '|' || vl.credit
   FROM \"VoucherLine\" vl JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE vl.\"voucherId\" = '$VCH_ID' AND vl.credit > 0;" 2>/dev/null | tr -d ' ')
assert_eq "voucher credit line is Forderung 1406" "$RECV_LINE" "1406|200.0000"

# Idempotent: confirm response carries voucherId
CONFIRM_HAS_VCH=$(json_field "$BODY" voucherId)
if [[ -n "$CONFIRM_HAS_VCH" && "$CONFIRM_HAS_VCH" != "null" ]]; then
  pass "confirm response includes voucherId"
else
  fail "confirm response missing voucherId: $BODY"
fi

# Double-confirm should fail (idempotency)
api_post "/api/v1/bank-statements/reconciliations/$RECON_ID/confirm?companyId=$COMPANY_ID" ""
assert_status "400" "double-confirm returns 400"

# === Reject flow: create a 2nd invoice + suggest + reject ===
CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"createdAt\", \"updatedAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 'INV-2026-TEST-002', 'INV', 'sent', '2026-06-03', '2026-06-10', 168.07, 31.93, 200.00, 'EUR', 'de-DE', now(), now());" >/dev/null 2>&1

# Upload a 2nd statement
cat > /tmp/e2e2.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST20260609002
:25:DE89370400440532013000
:28C:1/1
:60F:C260602EUR1000,00
:61:2606030603C200,00NTRFNONREF//Rechnung 99-9
Test
:62F:C260603EUR1200,00
-
EOF
UPLOAD2=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e2.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID2=$(json_field "$UPLOAD2" id)
TXN_ID2=$(echo "$UPLOAD2" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for t in d['transactions']:
    if float(t['amount']) == 200: print(t['id']); break
")

# Manual match for the 2nd statement (skips suggest UI)
INV2_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-002';" 2>/dev/null | tr -d ' ')
api_post "/api/v1/bank-statements/$SID2/transactions/$TXN_ID2/match?companyId=$COMPANY_ID" "{\"invoiceId\":\"$INV2_ID\"}"
assert_status "201" "manual match creates payment"
MANUAL_PAY=$(json_field "$BODY" paymentId)
if [[ -n "$MANUAL_PAY" && "$MANUAL_PAY" != "null" ]]; then
  pass "manual match paymentId: ${MANUAL_PAY:0:8}..."
fi

INV2_AFTER=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-002';" 2>/dev/null | tr -d ' ')
assert_eq "manual-match invoice status" "$INV2_AFTER" "paid"

# Reject flow: upload a 3rd statement and reject its suggestion
# We need a fresh, non-paid invoice that auto-suggest will match
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"createdAt\", \"updatedAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 'INV-2026-TEST-003', 'INV', 'sent', '2026-06-04', '2026-06-11', 168.07, 31.93, 200.00, 'EUR', 'de-DE', now(), now());" >/dev/null 2>&1
cat > /tmp/e2e3.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST20260609003
:25:DE89370400440532013000
:28C:1/1
:60F:C260603EUR1200,00
:61:2606040604C200,00NTRFNONREF//Testzweck
Test
:62F:C260604EUR1400,00
-
EOF
UPLOAD3=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e3.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID3=$(json_field "$UPLOAD3" id)

# === Auto-confirm threshold ===
# Reject the INV-2026-TEST-003 setup above so we have
# a fresh slate. Actually we want to test threshold
# BEFORE the reject test. Save the recon id, reject,
# then test threshold with a brand-new setup.
#
# Easier: use INV-2026-TEST-003 invoice (still sent,
# has a recon from the upcoming test). Actually, we
# have a chicken-and-egg here. The cleanest path is to
# reset the recons for SID3, then test threshold=0
# (no auto-confirm) and threshold=80 (auto-confirm).
# After threshold=80 the recon is already confirmed
# so the reject test below would fail. So:
#   1. threshold=0 → recon is suggested → reject it
#   2. THEN test threshold=80 on a fresh statement

# Generate suggestions with threshold=0
api_post "/api/v1/bank-statements/$SID3/suggest?companyId=$COMPANY_ID" '{}'
assert_status "201" "suggest for statement 3 (threshold=0)"
RECON3_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"BankReconciliation\" WHERE \"bankTransactionId\" IN (SELECT id FROM \"BankTransaction\" WHERE \"statementId\" = '$SID3') LIMIT 1;" 2>/dev/null | tr -d ' ')

# Response carries generated/autoConfirmed/threshold
GEN3=$(json_field "$BODY" generated)
AC3=$(json_field "$BODY" autoConfirmed)
TH3=$(json_field "$BODY" threshold)
assert_eq "threshold=0: generated count" "$GEN3" "1"
assert_eq "threshold=0: autoConfirmed=0" "$AC3" "0"
assert_eq "threshold=0: threshold echoed" "$TH3" "0"

# Reject the suggested match
api_post "/api/v1/bank-statements/reconciliations/$RECON3_ID/reject?companyId=$COMPANY_ID" ""
assert_status "201" "reject candidate"
RECON3_STATUS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE id = '$RECON3_ID';" 2>/dev/null | tr -d ' ')
assert_eq "reconciliation status after reject" "$RECON3_STATUS" "rejected"

# Try to confirm a rejected recon — should fail
api_post "/api/v1/bank-statements/reconciliations/$RECON3_ID/confirm?companyId=$COMPANY_ID" ""
assert_status "400" "confirm-rejected returns 400"

# === Auto-confirm threshold test ===
# Need a fresh invoice (the rejected one above has a
# recon that the suggest call will skip). Create
# INV-2026-TEST-AUTO and a fresh statement.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"createdAt\", \"updatedAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 'INV-2026-TEST-AUTO', 'INV', 'sent', '2026-06-05', '2026-06-12', 84.03, 15.97, 100.00, 'EUR', 'de-DE', now(), now());" >/dev/null 2>&1

cat > /tmp/e2e-auto.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:STAUTO001
:25:DE89370400440532013000
:28C:1/1
:60F:C260604EUR1400,00
:61:2606050605C100,00NTRFNONREF//Rechnung INV-2026-TEST-AUTO
Frau Müller
:62F:C260605EUR1500,00
-
EOF
UPLOAD_AUTO=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e-auto.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID_AUTO=$(json_field "$UPLOAD_AUTO" id)

# threshold=80: the top candidate scores 100 (purpose
# contains INV-2026-TEST-AUTO), so it should
# auto-confirm. The full confirm flow runs (Payment +
# Voucher + invoice paid).
api_post "/api/v1/bank-statements/$SID_AUTO/suggest?companyId=$COMPANY_ID" '{"autoConfirmThreshold": 80}'
assert_status "201" "suggest with autoConfirmThreshold=80"
GEN_AUTO=$(json_field "$BODY" generated)
AC_AUTO=$(json_field "$BODY" autoConfirmed)
assert_eq "threshold=80: generated=1" "$GEN_AUTO" "1"
assert_eq "threshold=80: autoConfirmed=1" "$AC_AUTO" "1"

# Verify the invoice is now paid
INV_AUTO_STATUS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE \"invoiceNumber\" = 'INV-2026-TEST-AUTO';" 2>/dev/null | tr -d ' ')
assert_eq "auto-confirm flipped invoice to paid" "$INV_AUTO_STATUS" "paid"

# Verify the recon is confirmed
RECON_AUTO_STATUS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE \"bankTransactionId\" IN (SELECT id FROM \"BankTransaction\" WHERE \"statementId\" = '$SID_AUTO');" 2>/dev/null | tr -d ' ')
assert_eq "auto-confirm flipped recon to confirmed" "$RECON_AUTO_STATUS" "confirmed"

# Verify the Payment + Voucher were created
PAY_AUTO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Payment\" p JOIN \"Invoice\" i ON i.id = p.\"invoiceId\" WHERE i.\"invoiceNumber\" = 'INV-2026-TEST-AUTO';" 2>/dev/null | tr -d ' ')
assert_eq "auto-confirm wrote Payment" "$PAY_AUTO" "1"

VCH_AUTO=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Voucher\" WHERE \"referenceType\" = 'BankReconciliation' AND \"voucherNumber\" LIKE 'BK-%' AND \"companyId\" = '$COMPANY_ID';" 2>/dev/null | tr -d ' ')
# We don't assert exact count (other tests wrote vouchers
# too) — just check ≥1 exists.
if [[ "$VCH_AUTO" -ge 1 ]]; then
  pass "auto-confirm wrote Voucher"
else
  fail "auto-confirm did not write a Voucher"
fi

# Re-running suggest is idempotent (no double auto-confirm)
api_post "/api/v1/bank-statements/$SID_AUTO/suggest?companyId=$COMPANY_ID" '{"autoConfirmThreshold": 80}'
assert_status "201" "re-run suggest with threshold=80 (idempotent)"
GEN_AUTO2=$(json_field "$BODY" generated)
AC_AUTO2=$(json_field "$BODY" autoConfirmed)
assert_eq "re-run: generated=0" "$GEN_AUTO2" "0"
assert_eq "re-run: autoConfirmed=0" "$AC_AUTO2" "0"

# === Reopen (undo) flow ===
# Test that a confirmed recon can be reopened with a
# Storno Voucher — GoBD-correct correction. The
# original Voucher stays in the books, the Storno
# nets each account to zero, the Payment is
# removed, and the invoice flips back to "sent".
AUTO_RECON_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"BankReconciliation\" WHERE \"bankTransactionId\" IN (SELECT id FROM \"BankTransaction\" WHERE \"statementId\" = '$SID_AUTO') LIMIT 1;" 2>/dev/null | tr -d ' ')
AUTO_INV_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"invoiceId\" FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
AUTO_VCH_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherId\" FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')

# State before reopen
RECON_BEFORE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "recon status before reopen" "$RECON_BEFORE" "confirmed"

INV_BEFORE_REOPEN=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE id = '$AUTO_INV_ID';" 2>/dev/null | tr -d ' ')
assert_eq "invoice status before reopen" "$INV_BEFORE_REOPEN" "paid"

# Reopen
api_post "/api/v1/bank-statements/reconciliations/$AUTO_RECON_ID/reopen?companyId=$COMPANY_ID" ""
assert_status "201" "reopen confirmed match"
STORNO_VCH_ID=$(json_field "$BODY" stornoVoucherId)
if [[ -n "$STORNO_VCH_ID" && "$STORNO_VCH_ID" != "null" ]]; then
  pass "reopen returned stornoVoucherId: ${STORNO_VCH_ID:0:8}..."
fi

# Verify
RECON_AFTER=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
# Reopen flips back to 'suggested' so the user can
# immediately re-confirm or pick a different candidate
# — better UX than locking the row in 'reopened'.
assert_eq "recon status after reopen" "$RECON_AFTER" "suggested"

INV_AFTER_REOPEN=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"Invoice\" WHERE id = '$AUTO_INV_ID';" 2>/dev/null | tr -d ' ')
assert_eq "invoice status after reopen" "$INV_AFTER_REOPEN" "sent"

PAY_AFTER_REOPEN=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$AUTO_INV_ID';" 2>/dev/null | tr -d ' ')
assert_eq "payments removed after reopen" "$PAY_AFTER_REOPEN" "0"

# Original Voucher still in books (GoBD immutability)
ORIG_VCH_STILL=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Voucher\" WHERE id = '$AUTO_VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "original voucher preserved" "$ORIG_VCH_STILL" "1"

# voucherId on the recon still points at the original
# Voucher (not overwritten by the Storno).
ORIG_LINKED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherId\" = '$AUTO_VCH_ID'::text FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucherId still points at original voucher" "$ORIG_LINKED" "t"

# reversalVoucherId is set to the Storno
STORN_LINKED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"reversalVoucherId\" = '$STORNO_VCH_ID'::text FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "reversalVoucherId set to Storno" "$STORN_LINKED" "t"

# Storno Voucher exists with correct referenceType
STORNO_REFTYPE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"referenceType\" FROM \"Voucher\" WHERE id = '$STORNO_VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "storno voucher referenceType" "$STORNO_REFTYPE" "BankReconciliationReversal"

# Per-account net effect: original + storno should net
# to zero on each account.
NET_BANK=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COALESCE(SUM(vl.debit) - SUM(vl.credit), 0)
   FROM \"VoucherLine\" vl
   JOIN \"Voucher\" v ON v.id = vl.\"voucherId\"
   JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE v.\"companyId\" = '$COMPANY_ID' AND v.id IN ('$AUTO_VCH_ID', '$STORNO_VCH_ID') AND a.\"accountNumber\" = '1200';" 2>/dev/null | tr -d ' ')
assert_eq "Bank 1200 nets to 0 after reopen" "$NET_BANK" "0.0000"

NET_RECV=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT COALESCE(SUM(vl.debit) - SUM(vl.credit), 0)
   FROM \"VoucherLine\" vl
   JOIN \"Voucher\" v ON v.id = vl.\"voucherId\"
   JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE v.\"companyId\" = '$COMPANY_ID' AND v.id IN ('$AUTO_VCH_ID', '$STORNO_VCH_ID') AND a.\"accountNumber\" = '1406';" 2>/dev/null | tr -d ' ')
assert_eq "Forderung 1406 nets to 0 after reopen" "$NET_RECV" "0.0000"

# === Re-confirm after reopen ===
# Reopen flips status back to 'suggested', so the
# user can immediately re-confirm. The full confirm
# flow runs again (Payment + new Voucher + invoice
# paid), but the Storno is preserved for the audit
# trail.
api_post "/api/v1/bank-statements/reconciliations/$AUTO_RECON_ID/confirm?companyId=$COMPANY_ID" ""
assert_status "201" "re-confirm after reopen"
RECONFIRM_VCH_ID=$(json_field "$BODY" voucherId)
if [[ -n "$RECONFIRM_VCH_ID" && "$RECONFIRM_VCH_ID" != "null" ]]; then
  pass "re-confirm wrote new Voucher: ${RECONFIRM_VCH_ID:0:8}..."
fi

# Status is now 'confirmed' again
RECON_RECONFIRMED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT status FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "recon status after re-confirm" "$RECON_RECONFIRMED" "confirmed"

# voucherId now points at the NEW voucher (overwritten
# from the reopen state), reversalVoucherId still set
RECONFIRMED_LINKED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherId\" = '$RECONFIRM_VCH_ID'::text FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "voucherId now points at re-confirm voucher" "$RECONFIRMED_LINKED" "t"

STORN_PRESERVED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"reversalVoucherId\" = '$STORNO_VCH_ID'::text FROM \"BankReconciliation\" WHERE id = '$AUTO_RECON_ID';" 2>/dev/null | tr -d ' ')
assert_eq "reversalVoucherId preserved across re-confirm" "$STORN_PRESERVED" "t"

# Original voucher still untouched
ORIG_STILL_THERE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Voucher\" WHERE id = '$AUTO_VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "original voucher still in books" "$ORIG_STILL_THERE" "1"

# All 3 vouchers for this recon chain exist
TOTAL_VCH=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"Voucher\" WHERE id IN ('$AUTO_VCH_ID', '$STORNO_VCH_ID', '$RECONFIRM_VCH_ID');" 2>/dev/null | tr -d ' ')
assert_eq "audit trail has all 3 vouchers" "$TOTAL_VCH" "3"

# listReconciliations returns the reversalVoucher
api_get "/api/v1/bank-statements/$SID_AUTO/reconciliations?companyId=$COMPANY_ID"
HAS_STORNO=$(echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if d and 'reversalVoucher' in d[0] and d[0]['reversalVoucher']:
    print('t')
else:
    print('f')
")
assert_eq "listReconciliations includes reversalVoucher" "$HAS_STORNO" "t"

# After re-confirm the recon is back to 'confirmed'
# — opening it AGAIN (which would create a SECOND
# Storno) is allowed (the user might want to undo
# again). What we test instead is the negative path:
# reopening the 'suggested' interim state is rejected.
# Reopen + reopen directly: first one flips suggested,
# the second one tries to reopen while already
# suggested, and the service refuses with 400.
api_post "/api/v1/bank-statements/reconciliations/$AUTO_RECON_ID/reopen?companyId=$COMPANY_ID" ""
assert_status "201" "reopen re-confirmed match (round 2)"
api_post "/api/v1/bank-statements/reconciliations/$AUTO_RECON_ID/reopen?companyId=$COMPANY_ID" ""
assert_status "400" "reopen-while-suggested returns 400"

# CAMT.053 round-trip: upload a sample XML and verify
# the same shape. Use a dedicated CAMT invoice
# (INV-2026-TEST-CAMT) so it doesn't conflict with
# INV-2026-TEST-E2E which is already paid by this point
# in the test sequence.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"type\", \"status\", \"issueDate\", \"dueDate\", \"subtotal\", \"totalVat\", \"total\", \"currency\", \"language\", \"createdAt\", \"updatedAt\")
   VALUES (gen_random_uuid()::text, '$COMPANY_ID', '$CUST_ID', 'INV-2026-TEST-CAMT', 'INV', 'sent', '2026-06-08', '2026-06-15', 168.07, 31.93, 200.00, 'EUR', 'de-DE', now(), now());" >/dev/null 2>&1

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
            <RmtInf><Ustrd>Rechnung INV-2026-TEST-CAMT</Ustrd></RmtInf>
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

# === Expense booking (debit txn → 4900 + 1200) ===
# Upload a statement with ONLY a debit transaction.
cat > /tmp/e2e-exp.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:STEXP001
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR500,00
:61:2606020602D85,50NTRFNONREF//Strom April
Stadtwerke
:62F:C260602EUR414,50
-
EOF
UPLOAD4=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e-exp.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID4=$(json_field "$UPLOAD4" id)
TXN_ID4=$(echo "$UPLOAD4" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for t in d['transactions']:
    if float(t['amount']) == -85.5: print(t['id']); break
")
note "debit txn: $TXN_ID4"

# Book as expense (default 4900)
api_post "/api/v1/bank-statements/$SID4/transactions/$TXN_ID4/book-expense?companyId=$COMPANY_ID" '{}'
assert_status "201" "book expense (default 4900)"
EXP_VCH_ID=$(json_field "$BODY" voucherId)
if [[ -n "$EXP_VCH_ID" && "$EXP_VCH_ID" != "null" ]]; then
  pass "expense voucher: ${EXP_VCH_ID:0:8}..."
fi

# Verify voucher shape
EXP_REFTYPE=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"referenceType\" FROM \"Voucher\" WHERE id = '$EXP_VCH_ID';" 2>/dev/null | tr -d ' ')
assert_eq "expense voucher referenceType" "$EXP_REFTYPE" "BankTransaction"

EXP_DEBIT_ACCT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT a.\"accountNumber\" || '|' || vl.debit
   FROM \"VoucherLine\" vl JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE vl.\"voucherId\" = '$EXP_VCH_ID' AND vl.debit > 0;" 2>/dev/null | tr -d ' ')
assert_eq "expense debit line is 4900" "$EXP_DEBIT_ACCT" "4900|85.5000"

EXP_CREDIT_ACCT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT a.\"accountNumber\" || '|' || vl.credit
   FROM \"VoucherLine\" vl JOIN \"Account\" a ON a.id = vl.\"accountId\"
   WHERE vl.\"voucherId\" = '$EXP_VCH_ID' AND vl.credit > 0;" 2>/dev/null | tr -d ' ')
assert_eq "expense credit line is 1200" "$EXP_CREDIT_ACCT" "1200|85.5000"

# Verify txn has voucherId linked
EXP_LINK=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT \"voucherId\" IS NOT NULL FROM \"BankTransaction\" WHERE id = '$TXN_ID4';" 2>/dev/null | tr -d ' ')
assert_eq "txn linked to voucher" "$EXP_LINK" "t"

# Double-book should fail
api_post "/api/v1/bank-statements/$SID4/transactions/$TXN_ID4/book-expense?companyId=$COMPANY_ID" '{}'
assert_status "400" "double-book returns 400"

# Try to book a credit txn as expense — should fail
# (use INV-2026-TEST-002's recon statement's earlier txns, but easier: upload a new one)
cat > /tmp/e2e-credit.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:STCRED001
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR100,00
:61:2606020602C50,00NTRFNONREF//Test
:62F:C260602EUR150,00
-
EOF
UPLOAD_C=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e-credit.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID_C=$(json_field "$UPLOAD_C" id)
TXN_ID_C=$(echo "$UPLOAD_C" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for t in d['transactions']:
    if float(t['amount']) == 50: print(t['id']); break
")
api_post "/api/v1/bank-statements/$SID_C/transactions/$TXN_ID_C/book-expense?companyId=$COMPANY_ID" '{}'
assert_status "400" "book-expense on credit txn returns 400"

# Custom account number
cat > /tmp/e2e-exp2.mt940 <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:STEXP002
:25:DE89370400440532013000
:28C:1/1
:60F:C260602EUR414,50
:61:2606030603D200,00NTRFNONREF//Büromaterial
Amazon
:62F:C260603EUR214,50
-
EOF
UPLOAD5=$(curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/bank-statements/import?companyId=$COMPANY_ID" \
  -F "file=@/tmp/e2e-exp2.mt940;type=text/plain" \
  -F "companyId=$COMPANY_ID" \
  -F "userId=$USER_ID")
SID5=$(json_field "$UPLOAD5" id)
TXN_ID5=$(echo "$UPLOAD5" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for t in d['transactions']:
    if float(t['amount']) == -200: print(t['id']); break
")
api_post "/api/v1/bank-statements/$SID5/transactions/$TXN_ID5/book-expense?companyId=$COMPANY_ID" '{"expenseAccountNumber":"4960","description":"Büromaterial Q2"}'
assert_status "201" "book expense with custom account 4960"
EXP2_VCH_ID=$(json_field "$BODY" voucherId)
EXP2_ACCT=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT a.\"accountNumber\" FROM \"VoucherLine\" vl JOIN \"Account\" a ON a.id = vl.\"accountId\" WHERE vl.\"voucherId\" = '$EXP2_VCH_ID' AND vl.debit > 0;" 2>/dev/null | tr -d ' ')
assert_eq "custom expense account used" "$EXP2_ACCT" "4960"

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';
   DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"companyId\" = '$COMPANY_ID' AND \"referenceType\" IN ('BankReconciliation', 'BankTransaction', 'BankReconciliationReversal'));
   DELETE FROM \"Voucher\" WHERE \"companyId\" = '$COMPANY_ID' AND \"referenceType\" IN ('BankReconciliation', 'BankTransaction', 'BankReconciliationReversal');
   DELETE FROM \"Payment\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" IN ('INV-2026-TEST-E2E', 'INV-2026-TEST-002', 'INV-2026-TEST-003', 'INV-2026-TEST-CAMT', 'INV-2026-TEST-AUTO'));
   DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" IN ('INV-2026-TEST-E2E', 'INV-2026-TEST-002', 'INV-2026-TEST-003', 'INV-2026-TEST-CAMT', 'INV-2026-TEST-AUTO');" >/dev/null 2>&1

summary
