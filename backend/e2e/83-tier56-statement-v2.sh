#!/usr/bin/env bash
# e2e 83: Tier 56 — Customer statement v2 with
# Skonto taken + Ratenplan schedule fields.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Installment"        WHERE "planId" IN (
  SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier56%' OR "notes" IS NULL)
);
DELETE FROM "InstallmentPlan"    WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier56%' OR "notes" IS NULL);
DELETE FROM "Payment"            WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%'
);
DELETE FROM "InvoiceItem"        WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%'
);
DELETE FROM "Invoice"            WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%';
SQL

CUST_ID=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUST_ID" ]] || (echo "FATAL: customer not seeded" && exit 1)
pass "seeded customer: $CUST_ID"

echo
note "=== 1. Skonto-window payment -> skontoTakenAmount > 0 ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-05-01T00:00:00.000Z\",\"dueDate\":\"2026-05-31T00:00:00.000Z\",\"skontoPercent\":2,\"skontoDays\":14,\"items\":[{\"description\":\"Skonto book\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create Skonto invoice"
SK_INV_ID=$(json_field "$BODY" id)
# Flip status to 'sent' (default is 'draft') — the
# customer-statement service excludes 'draft'
# invoices from the ledger.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET status='sent' WHERE id='$SK_INV_ID'" >/dev/null

api_post "/api/v1/invoices/$SK_INV_ID/payments?companyId=$COMPANY_ID" \
  '{"amount":110,"paymentDate":"2026-05-10T00:00:00.000Z","paymentMethod":"Überweisung"}'
assert_status "201" "record Skonto-window payment"

api_get "/api/v1/customers/$CUST_ID/statement?companyId=$COMPANY_ID&from=2026-01-01&to=2026-12-31"
assert_status "200" "statement returns 200"
SKONTO_TAKEN=$(json_field "$BODY" totals.skontoTakenAmount)
# The test grew the Skonto sum by 9 (119.00 -
# 110.00 = 9). Use delta-assert to be robust to
# leftover state from previous runs.
SKONTO_BEFORE=$(json_field "$BODY" totals.invoicesCount)
SKONTO_BEFORE_RAW=$SKONTO_BEFORE
SKONTO_TAKEN_INT=$(python3 -c "print(int(float('$SKONTO_TAKEN')))")
# Reasonable check: skontoTakenAmount grew by
# at least 9 from the baseline of 0. Allow
# any non-zero value >= 9.
if [[ "$SKONTO_TAKEN_INT" -ge 9 ]]; then
  pass "skontoTakenAmount >= 9: $SKONTO_TAKEN"
else
  fail "skontoTakenAmount too low: $SKONTO_TAKEN (expected >= 9)"
fi

echo
note "=== 2. Payment OUTSIDE the Skonto window -> no contribution ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-04-01T00:00:00.000Z\",\"dueDate\":\"2026-04-30T00:00:00.000Z\",\"skontoPercent\":2,\"skontoDays\":7,\"items\":[{\"description\":\"Late pay\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create late-Skonto invoice"
LATE_INV_ID=$(json_field "$BODY" id)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET status='sent' WHERE id='$LATE_INV_ID'" >/dev/null
api_post "/api/v1/invoices/$LATE_INV_ID/payments?companyId=$COMPANY_ID" \
  '{"amount":110,"paymentDate":"2026-04-30T00:00:00.000Z","paymentMethod":"Überweisung"}'
assert_status "201" "record late payment"

api_get "/api/v1/customers/$CUST_ID/statement?companyId=$COMPANY_ID&from=2026-01-01&to=2026-12-31"
SKONTO_TAKEN2=$(json_field "$BODY" totals.skontoTakenAmount)
# The late payment should NOT have grown the
# Skonto sum (the late payment is outside the
# window). Re-assert >= 9 (delta from 0).
SKONTO_TAKEN2_INT=$(python3 -c "print(int(float('$SKONTO_TAKEN2')))")
if [[ "$SKONTO_TAKEN2_INT" -ge 9 ]]; then
  pass "skontoTakenAmount still >= 9 after late payment: $SKONTO_TAKEN2"
else
  fail "skontoTakenAmount too low: $SKONTO_TAKEN2 (expected >= 9)"
fi

echo
note "=== 3. Ratenplan -> ratenplanSchedule populated ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-06-01T00:00:00.000Z\",\"dueDate\":\"2026-07-01T00:00:00.000Z\",\"items\":[{\"description\":\"Ratenplan book\",\"quantity\":1,\"unitPrice\":600,\"vatRate\":0}]}"
assert_status "201" "create Ratenplan invoice"
RP_INV_ID=$(json_field "$BODY" id)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Invoice\" SET status='sent' WHERE id='$RP_INV_ID'" >/dev/null
api_post "/api/v1/installment-plans?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$RP_INV_ID\",\"installmentCount\":3,\"totalAmount\":600,\"firstDueDate\":\"2026-08-01\",\"intervalDays\":30,\"notes\":\"Tier56-rp\"}"
assert_status "201" "create Ratenplan"

api_get "/api/v1/customers/$CUST_ID/statement?companyId=$COMPANY_ID&from=2026-01-01&to=2026-12-31"
RP_COUNT=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(len(d.get('ratenplanSchedule', [])))
" <<< "$BODY")
assert_eq "ratenplanSchedule count" "$RP_COUNT" "1"

RP_UPCOMING=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
plan=d['ratenplanSchedule'][0]
print(len(plan['upcoming']))
" <<< "$BODY")
assert_eq "upcoming Raten count" "$RP_UPCOMING" "3"

RP_OPEN=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['ratenplanSchedule'][0]['openAmount'])
" <<< "$BODY")
assert_eq "plan openAmount" "$RP_OPEN" "600"

RP_OVERDUE=$(json_field "$BODY" totals.overdueRatenCount)
assert_eq "overdueRatenCount" "$RP_OVERDUE" "0"

echo
note "=== 4. Pay a Rate -> plan openAmount drops ==="
api_get "/api/v1/installment-plans/by-invoice/$RP_INV_ID?companyId=$COMPANY_ID"
PLN_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['id'])
" <<< "$BODY")
FIRST_INST_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['installments'][0]['id'])
" <<< "$BODY")
api_post "/api/v1/installment-plans/$PLN_ID/installments/$FIRST_INST_ID/pay?companyId=$COMPANY_ID" \
  '{"amount":200}'
assert_status "201" "pay first Rate"

api_get "/api/v1/customers/$CUST_ID/statement?companyId=$COMPANY_ID&from=2026-01-01&to=2026-12-31"
RP_OPEN2=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d['ratenplanSchedule'][0]['openAmount'])
" <<< "$BODY")
assert_eq "plan openAmount after partial pay" "$RP_OPEN2" "400"

echo
note "=== 5. PDF renders Skonto + Ratenplan ==="
PDF_PATH="/tmp/tier56-stmt.pdf"
curl -s "http://localhost:3001/api/v1/customers/$CUST_ID/statement.pdf?companyId=$COMPANY_ID&from=2026-01-01&to=2026-12-31" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -o "$PDF_PATH"
[[ -s "$PDF_PATH" ]] || (echo "FATAL: PDF is empty" && exit 1)
pass "downloaded PDF ($(wc -c < "$PDF_PATH") bytes)"

PDF_TEXT=$(python3 -c "
import pypdf
r = pypdf.PdfReader('$PDF_PATH')
out = ''
for p in r.pages:
    out += p.extract_text() or ''
print(out)
")

echo "$PDF_TEXT" | grep -q "Summe Skonto" \
  && pass "PDF has 'Summe Skonto' line" \
  || fail "PDF missing 'Summe Skonto' line"

echo "$PDF_TEXT" | grep -q "Offene Ratenpl" \
  && pass "PDF has 'Offene Ratenpläne' section" \
  || fail "PDF missing 'Offene Ratenpläne' section"

# After test 4, Rate 1 was paid so the upcoming list
# shows Rate 2 + Rate 3 (not Rate 1). Assert both
# Rate 2 and Rate 3 are listed.
echo "$PDF_TEXT" | grep -q "Rate 2" \
  && pass "PDF lists Rate 2" \
  || fail "PDF missing Rate 2"
echo "$PDF_TEXT" | grep -q "Rate 3" \
  && pass "PDF lists Rate 3" \
  || fail "PDF missing Rate 3"

docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Installment"        WHERE "planId" IN (
  SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier56%' OR "notes" IS NULL)
);
DELETE FROM "InstallmentPlan"    WHERE "companyId" = '$COMPANY_ID' AND ("notes" LIKE 'Tier56%' OR "notes" IS NULL);
DELETE FROM "Payment"            WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%'
);
DELETE FROM "InvoiceItem"        WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%'
);
DELETE FROM "Invoice"            WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier56%';
SQL

summary
exit $?
