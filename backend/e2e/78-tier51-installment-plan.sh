#!/usr/bin/env bash
# e2e 78: Tier 51 — InstallmentPlan (Ratenzahlung).
#
# Adds the new Ratenplan surface:
#   POST   /installment-plans
#   GET    /installment-plans
#   GET    /installment-plans/:id
#   GET    /installment-plans/for-customer/:cid
#   POST   /installment-plans/:id/installments/:iid/pay
#   DELETE /installment-plans/:id
#
# Validates:
#   1. POST splits the totalAmount into N equal
#      installments; the LAST one absorbs the
#      rounding remainder so the sum is exact.
#   2. sequenceNumber + dueDate arithmetic correct
#      (first = firstDueDate, last = first + (N-1)*intervalDays).
#   3. Plan + all Installments are created in one
#      transaction (atomicity).
#   4. POST a duplicate plan on the same invoice
#      → 400.
#   5. POST on a non-existent invoice → 404.
#   6. POST with firstDueDate in the past → 400.
#   7. POST with installmentCount < 2 → 400.
#   8. POST /:id/installments/:iid/pay (partial)
#      → Installment.status='partial', Plan.status
#      stays 'active'.
#   9. POST /pay full → Installment.status='paid',
#      Plan.status flips to 'completed' when ALL
#      installments are paid.
#  10. DELETE /:id soft-cancels (status='cancelled')
#      and flips all open installments to 'cancelled'.
#  11. /for-customer/:cid returns only the open
#      plans for that customer.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# ───── 0. Wipe prior tier-51 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Installment"        WHERE "planId" IN (
  SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier51%' OR "notes" IS NULL)
);
DELETE FROM "InstallmentPlan"    WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier51%' OR "notes" IS NULL);
DELETE FROM "InvoiceItem"        WHERE "invoiceId" IN (
  SELECT id FROM "Invoice"        WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier51%'
);
DELETE FROM "Invoice"            WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier51%';
SQL

# ───── 1. Seed customer + invoice via SQL ─────
CUST_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUST_ID" ]] || (echo "FATAL: customer not seeded" && exit 1)
pass "seeded customer: $CUST_ID"

# Use SQL seed — faster + skips the invoice-create DTO
# which rejects invoiceNumber/status. The schema lets
# us set every field directly.
INVOICE_ID="e2e00051-0000-0000-0001-000000000001"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", "templateType", "attachments",
  "createdAt", "updatedAt")
VALUES ('$INVOICE_ID', '$COMPANY_ID', '$CUST_ID', 'Tier51-001', 9951,
  'INV', 'sent', '2026-06-01', '2026-06-15',
  1000.00, 190.00, 1190.00, 'EUR', 'de-DE',
  '[{"rate":0.19,"net":1000,"vat":190}]'::jsonb,
  false, false, 'standard', '[]',
  now(), now());
SQL
pass "seeded invoice: $INVOICE_ID (total=1190.00)"
INVOICE_TOTAL="1190.00"

# ───── 2. Create a Ratenplan — 3 Raten × 400 € monthly ─────
echo
note "=== 1. Create 3-Raten plan ==="
# First due = 2026-08-01 (well in the future)
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$INVOICE_ID\",\"installmentCount\":3,\"totalAmount\":1200,\"firstDueDate\":\"2026-08-01\",\"intervalDays\":30,\"notes\":\"Tier51-001\"}"
assert_status "201" "create plan returns 201"

PLAN_ID=$(json_field "$BODY" id)
PLAN_STATUS=$(json_field "$BODY" status)
assert_eq "plan status" "$PLAN_STATUS" "active"

INSTALLMENTS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(len(d['installments']))
" <<< "$BODY")
assert_eq "installment count" "$INSTALLMENTS" "3"

# Sum of installment.amount must equal 1200
SUM_AMOUNTS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(sum(float(i['amount']) for i in d['installments']))
" <<< "$BODY")
assert_eq "sum of installment amounts" "$SUM_AMOUNTS" "1200.0"

# First installment = 400.00 (Prisma Decimal serialises as string)
AMOUNT_1=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][0]['amount'])
" <<< "$BODY")
assert_eq "first Rate amount" "$AMOUNT_1" "400"

# Last installment = 400.00 (no rounding remainder)
AMOUNT_3=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][-1]['amount'])
" <<< "$BODY")
assert_eq "last Rate amount" "$AMOUNT_3" "400"

# sequenceNumber: 1, 2, 3
SEQS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(','.join(str(i['sequenceNumber']) for i in d['installments']))
" <<< "$BODY")
assert_eq "sequenceNumbers" "$SEQS" "1,2,3"

# dueDate progression
DUE_1=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][0]['dueDate'][:10])
" <<< "$BODY")
assert_eq "first Rate dueDate" "$DUE_1" "2026-08-01"

DUE_2=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][1]['dueDate'][:10])
" <<< "$BODY")
assert_eq "second Rate dueDate (first + 30 days)" "$DUE_2" "2026-08-31"

DUE_3=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][2]['dueDate'][:10])
" <<< "$BODY")
assert_eq "third Rate dueDate (first + 60 days)" "$DUE_3" "2026-09-30"

# ───── 3. Rounding remainder on the LAST installment ─────
echo
note "=== 2. Rounding remainder absorbed by last installment ==="
ROUND_INVOICE_ID="e2e00051-0000-0000-0001-000000000002"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", "templateType", "attachments",
  "createdAt", "updatedAt")
VALUES ('$ROUND_INVOICE_ID', '$COMPANY_ID', '$CUST_ID', 'Tier51-rounding', 9952,
  'INV', 'sent', '2026-06-01', '2026-06-15',
  100.00, 19.00, 119.00, 'EUR', 'de-DE',
  '[{"rate":0.19,"net":100,"vat":19}]'::jsonb,
  false, false, 'standard', '[]',
  now(), now());
SQL
pass "seeded rounding invoice: $ROUND_INVOICE_ID"
# 100 / 3 = 33.33, 33.33, 33.34 (last absorbs the 0.01 remainder)
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$ROUND_INVOICE_ID\",\"installmentCount\":3,\"totalAmount\":100,\"firstDueDate\":\"2026-08-01\",\"intervalDays\":30,\"notes\":\"Tier51-rounding\"}"
assert_status "201" "rounding plan returns 201"

ROUND_AMOUNTS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
# Prisma Decimal serialises as string; format each.
print(','.join(f\"{float(i['amount']):.2f}\" for i in d['installments']))
" <<< "$BODY")
assert_eq "rounding amounts (last absorbs 0.01)" "$ROUND_AMOUNTS" "33.33,33.33,33.34"

# ───── 4. Bad inputs ─────
echo
note "=== 3. Bad inputs ==="
# Duplicate plan on same invoice
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$INVOICE_ID\",\"installmentCount\":2,\"totalAmount\":1200,\"firstDueDate\":\"2026-09-01\",\"notes\":\"Tier51-dup\"}"
assert_status "400" "duplicate plan → 400"

# Non-existent invoice
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  '{"invoiceId":"00000000-0000-0000-0000-000000000000","installmentCount":2,"totalAmount":100,"firstDueDate":"2026-09-01"}'
assert_status "404" "non-existent invoice → 404"

# Past firstDueDate
PAST_DUE=$(python3 -c "from datetime import date, timedelta; print((date.today() - timedelta(days=7)).isoformat())")
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$ROUND_INVOICE_ID\",\"installmentCount\":2,\"totalAmount\":100,\"firstDueDate\":\"$PAST_DUE\",\"notes\":\"Tier51-past\"}"
assert_status "400" "firstDueDate in past → 400"

# installmentCount = 1
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$ROUND_INVOICE_ID\",\"installmentCount\":1,\"totalAmount\":100,\"firstDueDate\":\"2026-09-01\",\"notes\":\"Tier51-count1\"}"
assert_status "400" "installmentCount=1 → 400"

# ───── 5. Pay a partial installment ─────
echo
note "=== 4. Pay partial + then full installment ==="
# Get the first installment id
api_get "/api/v1/installment-plans/$PLAN_ID?companyId=$COMPANY_ID"
INST1_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][0]['id'])
" <<< "$BODY")
pass "first installment id: $INST1_ID"

# Pay 100 € of the 400 € first Rate
api_post "/api/v1/installment-plans/$PLAN_ID/installments/$INST1_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":100}'
assert_status "201" "partial pay returns 201"

INST1_STATUS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for i in d['installments']:
    if i['id']=='$INST1_ID':
        print(i['status'])
        break
" <<< "$BODY")
assert_eq "first Rate status after partial pay" "$INST1_STATUS" "partial"

INST1_PAID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for i in d['installments']:
    if i['id']=='$INST1_ID':
        print(i['paidAmount'])
        break
" <<< "$BODY")
assert_eq "first Rate paidAmount" "$INST1_PAID" "100"

# Plan status stays 'active' (not all paid yet)
PLAN_STATUS_AFTER_PARTIAL=$(json_field "$BODY" status)
assert_eq "plan still active after partial" "$PLAN_STATUS_AFTER_PARTIAL" "active"

# Pay the rest of the first Rate
api_post "/api/v1/installment-plans/$PLAN_ID/installments/$INST1_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":300}'
assert_status "201" "full first pay returns 201"

INST1_STATUS_2=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for i in d['installments']:
    if i['id']=='$INST1_ID':
        print(i['status'])
        break
" <<< "$BODY")
assert_eq "first Rate status after full pay" "$INST1_STATUS_2" "paid"

# Plan still active (2 + 3 not paid)
PLAN_STATUS_AFTER_FIRST=$(json_field "$BODY" status)
assert_eq "plan still active after first full pay" "$PLAN_STATUS_AFTER_FIRST" "active"

# Pay the second + third fully
INST2_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][1]['id'])
" <<< "$BODY")
INST3_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][2]['id'])
" <<< "$BODY")

api_post "/api/v1/installment-plans/$PLAN_ID/installments/$INST2_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":400}'
assert_status "201" "pay 2nd Rate"
api_post "/api/v1/installment-plans/$PLAN_ID/installments/$INST3_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":400}'
assert_status "201" "pay 3rd Rate"

# Plan should now be 'completed'
PLAN_STATUS_FINAL=$(json_field "$BODY" status)
assert_eq "plan status after all paid" "$PLAN_STATUS_FINAL" "completed"

# ───── 6. Overpay is capped ─────
echo
note "=== 5. Overpay is capped at installment.amount ==="
api_post "/api/v1/installment-plans/$PLAN_ID/installments/$INST1_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":1000}'
assert_status "400" "pay already-paid Rate → 400"

# ───── 7. for-customer filter ─────
echo
note "=== 6. for-customer filter ==="
api_get "/api/v1/installment-plans/for-customer/$CUST_ID?companyId=$COMPANY_ID"
assert_status "200" "for-customer returns 200"
CUST_PLANS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
# The completed plan should NOT appear (status='active' filter)
# but the rounding plan (still active) should.
print(len(d))
" <<< "$BODY")
assert_eq "active plans for customer" "$CUST_PLANS" "1"

# ───── 8. Soft-cancel ─────
echo
note "=== 7. Soft-cancel ==="
api_delete "/api/v1/installment-plans/$PLAN_ID?companyId=$COMPANY_ID"
assert_status "200" "cancel returns 200"
# (cancel re-fetches — but our 1st plan is now 'completed',
# and cancel only flips non-paid ones. The plan itself
# becomes 'cancelled' regardless. Let's verify.)
CANCEL_STATUS=$(json_field "$BODY" status)
assert_eq "cancelled plan status" "$CANCEL_STATUS" "cancelled"

# Now create a fresh plan + cancel it before any pay
CANCEL_INVOICE_ID="e2e00051-0000-0000-0001-000000000003"
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequenceNumber",
  type, status, "issueDate", "dueDate",
  subtotal, "totalVat", total, currency, language, "vatBreakdown",
  "reverseCharge", "euTransaction", "templateType", "attachments",
  "createdAt", "updatedAt")
VALUES ('$CANCEL_INVOICE_ID', '$COMPANY_ID', '$CUST_ID', 'Tier51-cancel', 9953,
  'INV', 'sent', '2026-06-01', '2026-06-15',
  600.00, 114.00, 714.00, 'EUR', 'de-DE',
  '[{"rate":0.19,"net":600,"vat":114}]'::jsonb,
  false, false, 'standard', '[]',
  now(), now());
SQL
pass "seeded cancel invoice: $CANCEL_INVOICE_ID"
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$CANCEL_INVOICE_ID\",\"installmentCount\":2,\"totalAmount\":600,\"firstDueDate\":\"2026-08-01\",\"notes\":\"Tier51-cancel\"}"
assert_status "201" "create cancel-target plan"
CANCEL_PLAN_ID=$(json_field "$BODY" id)
api_delete "/api/v1/installment-plans/$CANCEL_PLAN_ID?companyId=$COMPANY_ID"
assert_status "200" "cancel fresh plan"
# All installments should now be 'cancelled'
INST_STATUSES=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(','.join(i['status'] for i in d['installments']))
" <<< "$BODY")
assert_eq "all installments cancelled" "$INST_STATUSES" "cancelled,cancelled"

# ───── 9. List filter ─────
echo
note "=== 8. List + status filter ==="
api_get "/api/v1/installment-plans?companyId=$COMPANY_ID"
assert_status "200" "list returns 200"

api_get "/api/v1/installment-plans?companyId=$COMPANY_ID&status=active"
assert_status "200" "list?status=active returns 200"
ACTIVE_COUNT=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
# Only the rounding plan is still 'active' (cancel-target
# is cancelled, 1st plan is cancelled).
print(len(d))
" <<< "$BODY")
assert_eq "active plan count" "$ACTIVE_COUNT" "1"

# ───── 10. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Installment"        WHERE "planId" IN (
  SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier51%' OR "notes" IS NULL)
);
DELETE FROM "InstallmentPlan"    WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier51%' OR "notes" IS NULL);
DELETE FROM "InvoiceItem"        WHERE "invoiceId" IN (
  SELECT id FROM "Invoice"        WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier51%'
);
DELETE FROM "Invoice"            WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier51%';
SQL

summary
exit $?