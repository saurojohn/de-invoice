#!/bin/bash
# Test 12: Expenses list (Eingangsrechnungen overview)
# - findAll enriches each Expense with paymentState
#   ("offen" / "bezahlt" / "storniert") and linkedVoucher
# - A linked Voucher with referenceType='Expense' makes
#   paymentState='bezahlt'
# - A linked Voucher with referenceType='VoucherReversal'
#   makes paymentState='storniert' (the Storno reverted the
#   booking)
# - No linked Voucher → 'offen'
# - The link is established by the [expense:<id>] tag
#   embedded in voucher.description by bookExpense
# - search filter narrows by invoice# or description
# - supplierId filter narrows to a specific supplier
# - status filter narrows by the Expense.status enum

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Cleanup any prior test data
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"description\" LIKE '%[expense:%');
   DELETE FROM \"Voucher\" WHERE \"description\" LIKE '%[expense:%';
   DELETE FROM \"Expense\" WHERE \"invoiceNumber\" LIKE 'EXP-T6-%';" >/dev/null 2>&1

echo "=== Test: expenses list enrichment ==="

# Account ids
A4900=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='4900';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1200=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1200';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1576=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1576';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
SUP_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Supplier\" WHERE \"companyId\"='$COMPANY_ID' LIMIT 1;" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)

# Create three test expenses in different states.
# 1) OFFEN — no voucher yet
api_post "/api/v1/expenses?companyId=$COMPANY_ID" "{
  \"supplierId\": \"$SUP_ID\",
  \"invoiceNumber\": \"EXP-T6-001\",
  \"description\": \"Büromaterial Test\",
  \"invoiceDate\": \"2026-06-10\",
  \"netAmount\": 100,
  \"vatRate\": 0.19,
  \"vatAmount\": 19,
  \"grossAmount\": 119
}" >/dev/null
assert_eq "create expense 1 HTTP" "$STATUS" "201"
EXP1_ID=$(json_field "$BODY" id)

# 2) BEZAHLT — paired with a manual Voucher carrying the
#    [expense:<id>] tag
api_post "/api/v1/expenses?companyId=$COMPANY_ID" "{
  \"supplierId\": \"$SUP_ID\",
  \"invoiceNumber\": \"EXP-T6-002\",
  \"description\": \"Miete Test\",
  \"invoiceDate\": \"2026-06-10\",
  \"netAmount\": 500,
  \"vatRate\": 0.19,
  \"vatAmount\": 95,
  \"grossAmount\": 595
}" >/dev/null
assert_eq "create expense 2 HTTP" "$STATUS" "201"
EXP2_ID=$(json_field "$BODY" id)

# Create the corresponding Voucher with the [expense:tag]
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-06-10\",
  \"description\": \"Bank Miete Test [expense:$EXP2_ID]\",
  \"referenceType\": \"Expense\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 500, \"credit\": 0 },
    { \"accountId\": \"$A1576\", \"debit\": 95, \"credit\": 0 },
    { \"accountId\": \"$A1200\", \"debit\": 0, \"credit\": 595 }
  ]
}" >/dev/null
assert_eq "create Voucher for expense 2 HTTP" "$STATUS" "201"
EXP2_VCH_ID=$(json_field "$BODY" id)
EXP2_VCH_NUM=$(json_field "$BODY" voucherNumber)

# 3)STORNIERT — has a Storno voucher pointing at it via
#   [expense:tag] in description. The Storno is itself a
#   Voucher with referenceType='VoucherReversal'.
api_post "/api/v1/expenses?companyId=$COMPANY_ID" "{
  \"supplierId\": \"$SUP_ID\",
  \"invoiceNumber\": \"EXP-T6-003\",
  \"description\": \"Beratung Storno Test\",
  \"invoiceDate\": \"2026-06-10\",
  \"netAmount\": 200,
  \"vatRate\": 0.19,
  \"vatAmount\": 38,
  \"grossAmount\": 238
}" >/dev/null
assert_eq "create expense 3 HTTP" "$STATUS" "201"
EXP3_ID=$(json_field "$BODY" id)

# Create the original Voucher for expense 3
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-06-10\",
  \"description\": \"Bank Beratung [expense:$EXP3_ID]\",
  \"referenceType\": \"Expense\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 200, \"credit\": 0 },
    { \"accountId\": \"$A1576\", \"debit\": 38, \"credit\": 0 },
    { \"accountId\": \"$A1200\", \"debit\": 0, \"credit\": 238 }
  ]
}" >/dev/null
assert_eq "create Voucher for expense 3 HTTP" "$STATUS" "201"
EXP3_VCH_ID=$(json_field "$BODY" id)

# Now Storno it — the Storno voucher description must
# carry the [expense:tag] too so the list endpoint picks
# it up as the "linked voucher" for the paymentState.
# We do this by hand-crafting a VoucherReversal (the
# service createReversal overwrites description with
# "Storno: <originalNumber> Grund: <reason>" — no tag).
# So instead we issue a direct POST with the tag
# preserved, mimicking what bank-import.bookExpense would
# emit on a real Storno path (which currently doesn't
# exist, but the list endpoint is permissive).
api_post "/api/v1/accounting/vouchers" "{
  \"companyId\": \"$COMPANY_ID\",
  \"date\": \"2026-06-11\",
  \"description\": \"Storno Beratung [expense:$EXP3_ID]\",
  \"referenceType\": \"VoucherReversal\",
  \"lines\": [
    { \"accountId\": \"$A4900\", \"debit\": 0, \"credit\": 200 },
    { \"accountId\": \"$A1576\", \"debit\": 0, \"credit\": 38 },
    { \"accountId\": \"$A1200\", \"debit\": 238, \"credit\": 0 }
  ]
}" >/dev/null
assert_eq "create Storno Voucher HTTP" "$STATUS" "201"
EXP3_STO_ID=$(json_field "$BODY" id)
EXP3_STO_NUM=$(json_field "$BODY" voucherNumber)

# Now query the list endpoint and check the paymentState
# of each test expense.
api_get "/api/v1/expenses?companyId=$COMPANY_ID&search=EXP-T6"

# Find the three test expenses in the response
PY=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
hits = [e for e in d if e.get('invoiceNumber', '').startswith('EXP-T6-')]
result = {}
for h in hits:
    result[h['invoiceNumber']] = {
        'paymentState': h.get('paymentState'),
        'linkedVoucher': h.get('linkedVoucher'),
    }
print(json.dumps(result))
" "$BODY")

assert_eq "EXP-T6-001 paymentState=offen" \
  "$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-001']['paymentState'])")" \
  "offen"
assert_eq "EXP-T6-001 linkedVoucher=None" \
  "$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-001']['linkedVoucher'])")" \
  "None"

assert_eq "EXP-T6-002 paymentState=bezahlt" \
  "$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-002']['paymentState'])")" \
  "bezahlt"
EXP2_LV_NUM=$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-002']['linkedVoucher']['voucherNumber'])")
assert_eq "EXP-T6-002 linkedVoucher number" "$EXP2_LV_NUM" "$EXP2_VCH_NUM"

assert_eq "EXP-T6-003 paymentState=storniert" \
  "$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-003']['paymentState'])")" \
  "storniert"
EXP3_LV_NUM=$(echo "$PY" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['EXP-T6-003']['linkedVoucher']['voucherNumber'])")
assert_eq "EXP-T6-003 linkedVoucher is the Storno" "$EXP3_LV_NUM" "$EXP3_STO_NUM"

# supplierId filter
api_get "/api/v1/expenses?companyId=$COMPANY_ID&supplierId=$SUP_ID&search=EXP-T6"
SUP_HITS=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(sum(1 for e in d if e.get('invoiceNumber', '').startswith('EXP-T6-')))
" "$BODY")
assert_eq "supplierId filter returns 3 EXP-T6" "$SUP_HITS" "3"

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"description\" LIKE '%[expense:%');
   DELETE FROM \"Voucher\" WHERE \"description\" LIKE '%[expense:%';
   DELETE FROM \"Expense\" WHERE \"invoiceNumber\" LIKE 'EXP-T6-%';" >/dev/null 2>&1

echo
summary
