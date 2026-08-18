#!/usr/bin/env bash
# e2e 85: Tier 58 — Customer credit balance (Kundenguthaben) +
# Auszahlung (refund) flow.
#
# Validates the full ledger lifecycle:
#   1. GET /customers/:id/credit-balance returns 0 for a fresh
#      customer.
#   2. GET /customers/:id/credit-ledger returns [] for a fresh
#      customer.
#   3. Overpaying an invoice auto-records an 'overpayment' row
#      in the ledger (Payment.amount > invoice total).
#   4. POST /customers/:id/credit-payout issues an Auszahlung
#      Voucher (1800/1200 Bank Soll ↔ 1400/1210 Forderungen
#      Haben) AND records a 'payout' row reducing the balance.
#   5. POST /customers/:id/apply-credit records an 'apply' row
#      AND adds a synthetic Payment (paymentMethod='Guthaben')
#      to the target invoice.
#   6. POST /customers/:id/credit-adjust with a positive
#      amount adds manual credit; with a negative amount
#      uses credit (both ledger rows tagged 'manual').
#   7. Payout that exceeds the balance returns 400 (defence
#      against the classic "refund more than the customer
#      is owed" bug).
#   8. Invariants:
#      - SUM(amount) over all ledger rows === current balance
#      - Each ledger row's balanceAfter === prior balanceAfter
#        ± amount
#      - 'payout' rows have a non-null referenceId pointing
#        at a real Voucher with matching Soll/Haben

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# ───── 0. Wipe prior tier-58 fixtures (idempotent re-runs) ─────
# Our tier-58 fixtures use a stable, non-tier-prefixed
# customer name `Tier58-CreditTest-<uuid>` so the shared
# e2e DB cleanup LIKE 'Tier58%' doesn't sweep historical
# fixtures from other tiers.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "CustomerCreditTransaction" WHERE "companyId" = '$COMPANY_ID'
  AND "description" LIKE 'Tier58-%';
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher"
  WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier58-Auszahlung%'
);
DELETE FROM "Voucher" WHERE "companyId" = '$COMPANY_ID'
  AND "description" LIKE 'Tier58-Auszahlung%';
DELETE FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND name LIKE 'Tier58-CreditTest%';
SQL
pass "wiped prior tier-58 fixtures"

# ───── 1. Seed a fresh customer ─────
CUST_RESP=$(curl -sS -X POST "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID" \
  -d "{\"name\":\"Tier58-CreditTest-$(date +%s)\",\"type\":\"business\",\"address\":{\"city\":\"Berlin\"}}")
CUST_ID=$(echo "$CUST_RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
[[ -n "$CUST_ID" ]] || (echo "FATAL: customer not created: $CUST_RESP" && exit 1)
pass "seeded customer: $CUST_ID"

# ───── 2. Initial balance = 0, ledger = [] ─────
echo
note "=== 1. fresh customer: balance=0, ledger=[] ==="
api_get "/api/v1/customers/$CUST_ID/credit-balance?companyId=$COMPANY_ID"
assert_status 200 "GET credit-balance"
assert_eq "initial balance" "$(json_field "$BODY" balance)" "0"
assert_eq "initial currency" "$(json_field "$BODY" currency)" "EUR"

api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
assert_status 200 "GET credit-ledger"
LEDGER_LEN=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
assert_eq "initial ledger length" "$LEDGER_LEN" "0"

# ───── 3. Seed an unpaid invoice (100 EUR net → 119 EUR gross) ─────
echo
note "=== 2. seed invoice (100 EUR net → 119 EUR gross) ==="
TODAY=$(date -u +%Y-%m-%dT00:00:00.000Z)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"$TODAY\",\"dueDate\":\"$TODAY\",\"items\":[{\"description\":\"Tier58 test item\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status 201 "create invoice"
INV_ID=$(json_field "$BODY" id)
INV_TOTAL=$(json_field "$BODY" total)
assert_eq "invoice total" "$INV_TOTAL" "119"
# Flip to 'sent' (default draft, excluded from payments... actually
# payments are allowed on draft in the create flow, so we can
# skip the flip; but the post-payment status update only fires
# for status='sent' going to 'paid', so flipping keeps the
# status-transition webhook consistent with real usage).
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET status='sent' WHERE id='$INV_ID'" >/dev/null

# ───── 4. Overpay the invoice by 31 EUR (pay 150, invoice 119) ─────
echo
note "=== 3. overpay invoice (150 vs 119) → overpayment +31 to credit ==="
api_post "/api/v1/invoices/$INV_ID/payments?companyId=$COMPANY_ID" \
  '{"amount": 150, "paymentDate": "2026-07-16", "paymentMethod": "Überweisung"}'
assert_status 201 "POST payment 150 EUR"
PAY_ID=$(json_field "$BODY" id)

# Balance should now be 31
api_get "/api/v1/customers/$CUST_ID/credit-balance?companyId=$COMPANY_ID"
assert_status 200 "GET credit-balance after overpay"
assert_eq "balance after overpay" "$(json_field "$BODY" balance)" "31"

# Ledger should have 1 row
api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
LEDGER_LEN=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
assert_eq "ledger length after overpay" "$LEDGER_LEN" "1"
ROW_TYPE=$(python3 -c "import json,sys;print(json.load(sys.stdin)[0]['type'])" <<< "$BODY")
ROW_AMOUNT=$(python3 -c "import json,sys;print(json.load(sys.stdin)[0]['amount'])" <<< "$BODY")
ROW_REF_TYPE=$(python3 -c "import json,sys;print(json.load(sys.stdin)[0]['referenceType'])" <<< "$BODY")
ROW_REF_ID=$(python3 -c "import json,sys;print(json.load(sys.stdin)[0]['referenceId'])" <<< "$BODY")
ROW_BAL_AFTER=$(python3 -c "import json,sys;print(json.load(sys.stdin)[0]['balanceAfter'])" <<< "$BODY")
assert_eq "ledger[0].type" "$ROW_TYPE" "overpayment"
assert_eq "ledger[0].amount" "$ROW_AMOUNT" "31"
assert_eq "ledger[0].referenceType" "$ROW_REF_TYPE" "Payment"
assert_eq "ledger[0].referenceId == paymentId" "$ROW_REF_ID" "$PAY_ID"
assert_eq "ledger[0].balanceAfter" "$ROW_BAL_AFTER" "31"

# ───── 5. Issue an Auszahlung (payout) for 25 EUR ─────
echo
note "=== 4. credit-payout 25 EUR → Voucher (1200/1400) + payout row ==="
# Look up the 1200 (Bank) account id
BANK_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200' LIMIT 1")
[[ -n "$BANK_ID" ]] || (echo "FATAL: Bank account 1200 not seeded" && exit 1)
api_post "/api/v1/customers/$CUST_ID/credit-payout?companyId=$COMPANY_ID" \
  "{\"amount\": 25, \"paymentDate\": \"2026-07-16\", \"bankAccountId\": \"$BANK_ID\", \"description\": \"Tier58-Auszahlung Test\"}"
assert_status 201 "POST credit-payout 25 EUR"
VOUCHER_ID=$(json_field "$BODY" voucherId)
VOUCHER_NUM=$(json_field "$BODY" voucherNumber)
LEDGER_AFTER=$(json_field "$BODY" balanceAfter)
assert_eq "payout voucherNumber starts with BK-" "$(echo "$VOUCHER_NUM" | grep -c '^BK-')" "1"
assert_eq "balanceAfter payout" "$LEDGER_AFTER" "6"

# Verify the Voucher lines (1200 Bank Soll, 1400 Forderungen Haben)
VOUCHER=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/$VOUCHER_ID?companyId=$COMPANY_ID")
# The single-voucher GET endpoint returns the lines but no
# `balanced` summary field, so we compute it from lines.
VOUCHER_SOLL=$(echo "$VOUCHER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
soll = sum(float(l['debit']) for l in d.get('lines', []))
print(f'{soll:.2f}')
")
VOUCHER_HABEN=$(echo "$VOUCHER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
haben = sum(float(l['credit']) for l in d.get('lines', []))
print(f'{haben:.2f}')
")
VOUCHER_BAL_OK=$(python3 -c "print('OK' if abs($VOUCHER_SOLL - $VOUCHER_HABEN) < 0.01 else 'UNBALANCED')")
assert_eq "Voucher balanced" "$VOUCHER_BAL_OK" "OK"
assert_eq "Voucher Soll=25.00" "$VOUCHER_SOLL" "25.00"
assert_eq "Voucher Haben=25.00" "$VOUCHER_HABEN" "25.00"
# Verify the two lines hit the right Sachkonten (1200 Bank + 1400 Forderungen).
VOUCHER_ACCOUNTS=$(echo "$VOUCHER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
accs = sorted({l['account']['accountNumber'] for l in d.get('lines', [])})
print('|'.join(accs))
")
assert_eq "Voucher accounts" "$VOUCHER_ACCOUNTS" "1200|1400"

# Verify ledger now has 2 rows (overpayment + payout)
api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
LEDGER_LEN=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
assert_eq "ledger length after payout" "$LEDGER_LEN" "2"
# Find the payout row
PAYOUT_ROW=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d:
    if r['type'] == 'payout':
        print(f\"{r['amount']}|{r['balanceAfter']}|{r['referenceType']}|{r['referenceId']}\")
        break
" <<< "$BODY")
assert_eq "payout row amount=-25, balance=6, ref=Voucher" "$PAYOUT_ROW" "-25|6|Voucher|$VOUCHER_ID"

# ───── 6. Apply remaining 6 EUR to a new invoice ─────
echo
note "=== 5. apply-credit 6 EUR to a 2nd invoice → apply row + synthetic payment ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"$TODAY\",\"dueDate\":\"$TODAY\",\"items\":[{\"description\":\"Tier58 2nd item\",\"quantity\":1,\"unitPrice\":200,\"vatRate\":0.19}]}"
assert_status 201 "create 2nd invoice"
INV2_ID=$(json_field "$BODY" id)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET status='sent' WHERE id='$INV2_ID'" >/dev/null

api_post "/api/v1/customers/$CUST_ID/apply-credit?companyId=$COMPANY_ID" \
  "{\"invoiceId\": \"$INV2_ID\", \"amount\": 6}"
assert_status 201 "POST apply-credit 6 EUR"
assert_eq "apply-credit balanceAfter" "$(json_field "$BODY" balanceAfter)" "0"

# Verify the synthetic Payment row on the 2nd invoice
# Payment.amount is Decimal(12,4) so PostgreSQL may serialise
# the value as "6.0000" — the e2e must match the wire format
# from `text(...)::numeric` directly.
SYNTH_PAY=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT amount::text||'|'||\"paymentMethod\" FROM \"Payment\" WHERE \"invoiceId\" = '$INV2_ID'")
assert_eq "synthetic payment row" "$SYNTH_PAY" "6.0000|Guthaben"

# Balance should now be 0
api_get "/api/v1/customers/$CUST_ID/credit-balance?companyId=$COMPANY_ID"
assert_eq "balance after apply" "$(json_field "$BODY" balance)" "0"

# Ledger should have 3 rows now
api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
LEDGER_LEN=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
assert_eq "ledger length after apply" "$LEDGER_LEN" "3"

# ───── 7. Manual adjustment: add 50 EUR credit ─────
echo
note "=== 6. credit-adjust +50 (manual credit) ==="
api_post "/api/v1/customers/$CUST_ID/credit-adjust?companyId=$COMPANY_ID" \
  '{"amount": 50, "description": "Tier58-Manual Gutschrift Q2"}'
assert_status 201 "POST credit-adjust +50"
assert_eq "balance after +50 manual" "$(json_field "$BODY" balanceAfter)" "50"

# Manual debit -20
api_post "/api/v1/customers/$CUST_ID/credit-adjust?companyId=$COMPANY_ID" \
  '{"amount": -20, "description": "Tier58-Manual Korrektur"}'
assert_status 201 "POST credit-adjust -20"
assert_eq "balance after -20 manual" "$(json_field "$BODY" balanceAfter)" "30"

# Ledger should have 5 rows (3 prior + 2 manual)
api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
LEDGER_LEN=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)))" <<< "$BODY")
assert_eq "ledger length after manual" "$LEDGER_LEN" "5"

# ───── 8. Payout that exceeds balance returns 400 ─────
echo
note "=== 7. payout exceeding balance → 400 ==="
api_post "/api/v1/customers/$CUST_ID/credit-payout?companyId=$COMPANY_ID" \
  "{\"amount\": 100, \"paymentDate\": \"2026-07-16\", \"bankAccountId\": \"$BANK_ID\"}"
assert_status 400 "POST credit-payout 100 EUR (over 30 balance)"

# Balance unchanged
api_get "/api/v1/customers/$CUST_ID/credit-balance?companyId=$COMPANY_ID"
assert_eq "balance unchanged after refused payout" "$(json_field "$BODY" balance)" "30"

# ───── 9. Invariants ─────
echo
note "=== 8. ledger invariants ==="
api_get "/api/v1/customers/$CUST_ID/credit-ledger?companyId=$COMPANY_ID"
# Invariant A: SUM(amount) === current balance
SUM_AMT=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
print(sum(r['amount'] for r in d))
" <<< "$BODY")
assert_eq "SUM(amount) = 30" "$SUM_AMT" "30"

# Invariant B: each row's balanceAfter === prior + amount (running balance is monotonic)
RUN_OK=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
prior = 0
ok = True
for r in d:
    expected = prior + r['amount']
    if abs(expected - r['balanceAfter']) > 0.005:
        ok = False
        break
    prior = r['balanceAfter']
print('OK' if ok else 'BROKEN')
" <<< "$BODY")
assert_eq "running balance invariant" "$RUN_OK" "OK"

# ───── 10. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "CustomerCreditTransaction" WHERE "companyId" = '$COMPANY_ID'
  AND "description" LIKE 'Tier58-%';
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher"
  WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier58-Auszahlung%'
);
DELETE FROM "Voucher" WHERE "companyId" = '$COMPANY_ID'
  AND "description" LIKE 'Tier58-Auszahlung%';
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "customerId" = '$CUST_ID'
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "customerId" = '$CUST_ID'
);
DELETE FROM "Invoice" WHERE "customerId" = '$CUST_ID';
DELETE FROM "Customer" WHERE id = '$CUST_ID';
SQL
pass "cleanup complete"

summary
exit $?
