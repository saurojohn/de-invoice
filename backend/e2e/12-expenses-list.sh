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

# Tier 447: only this spec's vouchers — the pattern '%[expense:%' hit every
# company's bank bookings, and one referenced by a bank transaction made the
# whole statement fail. Storno vouchers (no tag, reversedById) go first.
T6_VOUCHERS="SELECT v.id FROM \"Voucher\" v JOIN \"Expense\" e ON v.description LIKE '%[expense:' || e.id || ']%' WHERE e.\"invoiceNumber\" LIKE 'EXP-T6-%'"
CLEANUP_SQL="DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN (SELECT id FROM \"Voucher\" WHERE \"reversedById\" IN ($T6_VOUCHERS));
   DELETE FROM \"Voucher\" WHERE \"reversedById\" IN ($T6_VOUCHERS);
   DELETE FROM \"VoucherLine\" WHERE \"voucherId\" IN ($T6_VOUCHERS);
   DELETE FROM \"Voucher\" WHERE id IN ($T6_VOUCHERS);
   DELETE FROM \"Expense\" WHERE \"invoiceNumber\" LIKE 'EXP-T6-%';"
# Cleanup any prior test data
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "$CLEANUP_SQL" >/dev/null 2>&1

echo "=== Test: expenses list enrichment ==="

# Account ids
A4900=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='4900';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1200=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1200';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
A1576=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\"='$COMPANY_ID' AND \"accountNumber\"='1576';" 2>/dev/null | grep -E '^[0-9a-f-]{36}$' | head -1)
SUP_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
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

# Tier 811: the bank payment of an expense is a voucher the bank import writes
# (referenceType "Expense", "[expense:<id>]"); POST /accounting/vouchers books
# manual vouchers only, so the fixture writes that voucher directly.
bank_voucher() { # expenseId date description net vat gross → "id number"
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
    "WITH v AS (INSERT INTO \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status)
       VALUES (gen_random_uuid()::text, '$COMPANY_ID', 'T6-' || substr(md5(random()::text), 1, 10), '$2', '$3 [expense:$1]', 'Expense', 'posted')
       RETURNING id, \"voucherNumber\"),
     l AS (INSERT INTO \"VoucherLine\" (id, \"voucherId\", \"accountId\", debit, credit, \"sortOrder\")
       SELECT gen_random_uuid()::text, v.id, x.a, x.d, x.c, x.o FROM v,
         (VALUES ('$A4900', $4, 0, 0), ('$A1576', $5, 0, 1), ('$A1200', 0, $6, 2)) AS x(a, d, c, o))
     SELECT id || ' ' || \"voucherNumber\" FROM v;" 2>/dev/null | head -1
}

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
read -r EXP2_VCH_ID EXP2_VCH_NUM < <(bank_voucher "$EXP2_ID" 2026-06-10 "Bank Miete Test" 500 95 595)
assert_eq "create Voucher for expense 2" "$([[ -n $EXP2_VCH_ID ]] && echo ok)" "ok"

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
read -r EXP3_VCH_ID EXP3_VCH_NUM < <(bank_voucher "$EXP3_ID" 2026-06-10 "Bank Beratung" 200 38 238)
assert_eq "create Voucher for expense 3" "$([[ -n $EXP3_VCH_ID ]] && echo ok)" "ok"

# Now Storno it through the real route. Until Tier 447 the list only
# recognised a Storno whose own description carried the tag, which
# createReversal never writes ("Storno: <number> Grund: …"), so this spec
# hand-crafted one; the list now sees the original as reversed.
api_post "/api/v1/accounting/vouchers/$EXP3_VCH_ID/reversal?companyId=$COMPANY_ID" '{"reason":"Test"}'
assert_eq "create Storno Voucher HTTP" "$STATUS" "201"
EXP3_STO_ID=$(json_field "$BODY" id)

# Now query the list endpoint and check the paymentState
# of each test expense.
api_get "/api/v1/expenses?companyId=$COMPANY_ID&search=EXP-T6"

# Find the three test expenses in the response
PY=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
hits = [e for e in d.get('data', []) if e.get('invoiceNumber', '').startswith('EXP-T6-')]
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
assert_eq "EXP-T6-003 linkedVoucher is the reversed booking" "$EXP3_LV_NUM" "$EXP3_VCH_NUM"

# supplierId filter
api_get "/api/v1/expenses?companyId=$COMPANY_ID&supplierId=$SUP_ID&search=EXP-T6"
SUP_HITS=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(sum(1 for e in d.get('data', []) if e.get('invoiceNumber', '').startswith('EXP-T6-')))
" "$BODY")
assert_eq "supplierId filter returns 3 EXP-T6" "$SUP_HITS" "3"

# Cleanup
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
  "$CLEANUP_SQL" >/dev/null 2>&1

echo
summary
