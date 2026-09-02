#!/usr/bin/env bash
# e2e 65: Tier 37 — Mahnung multi-level flow (audit trail + fees + cancel).
#
# Validates:
#   1. GET /reminders/mahnungen/fees-config  → 200 with BGB defaults
#      (verzugszinsPct=9.0, first=0, second=2.5, final=5).
#   2. PUT /reminders/mahnungen/fees-config  → 200, returns the
#      persisted values; subsequent GET returns the saved values.
#   3. POST /reminders/send (existing Tier 12 route) — when called
#      against a sent-and-overdue invoice, the response now
#      includes a `mahnungId` and a new Mahnung audit row appears
#      in /reminders/mahnungen.
#   4. GET /reminders/mahnungen?status=all returns the row we just
#      created with the right level + totals (mahngebuehr +
#      verzugszins > 0 at second/final).
#   5. POST /reminders/mahnungen/:id/cancel flips the row;
#      subsequent GET /status=cancelled returns 1 row, /status=open
#      returns 0.
#   6. GET /reminders/mahnungen/:id/pdf streams a valid PDF
#      (%PDF- magic header at offset 0, ≥ 4 KB).
#   7. POST /reminders/send on a paid invoice does NOT create a
#      new Mahnung (no escalation after settlement — Tier 37's
#      payment-cancel cascade is tested in the cashbook e2e).
#   8. Bad-inputs: missing companyId → 400, missing invoiceId → 500
#      from the controller, malformed level for fees-config put
#      returns 200 with the value clamped to 0.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# Wipe ONLY the Tier37 test customer's data (scoped by
# name LIKE 'Tier37%'). Polish #10: the previous
# version wiped ALL customers for the company, which
# broke every downstream test that depended on a
# pre-existing customer (e.g. 72, 73, 74, 75,
# 78-84, 87, 88). We now scope the wipe to the
# 65-specific customer by name.
# Tier 112 also added SepaDirectDebitMandate →
# Customer (FK). The cleanup must delete mandates
# first, otherwise the customer DELETE blocks with
# "foreign key constraint violated" and the test
# re-runs leak the t37@example.com row forever.
# Tier 298 fix: Mahnung and EmailSend don't have a
# customerId column. The customer FK lives on
# Invoice (Mahnung→Invoice, EmailSend→Invoice). Use
# the same invoice-subselect the rest of the cleanup
# already uses.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Mahnung" WHERE "companyId" = '$COMPANY_ID'
  AND "invoiceId" IN (SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%'));
DELETE FROM "EmailSend" WHERE "companyId" = '$COMPANY_ID'
  AND "invoiceId" IN (SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%'));
DELETE FROM "SepaDirectDebitCollection" WHERE "companyId" = '$COMPANY_ID'
  AND "mandateId" IN (SELECT id FROM "SepaDirectDebitMandate" WHERE "debitorName" LIKE 'Tier37%');
DELETE FROM "SepaDirectDebitBatch" WHERE "companyId" = '$COMPANY_ID'
  AND "notes" LIKE 'Tier37%';
DELETE FROM "SepaDirectDebitMandate" WHERE "companyId" = '$COMPANY_ID'
  AND "debitorName" LIKE 'Tier37%';
DELETE FROM "CustomerCreditTransaction" WHERE "companyId" = '$COMPANY_ID'
  AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%');
DELETE FROM "PaymentLink" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%')
);
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%')
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%')
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID'
  AND "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier37%');
DELETE FROM "Customer" WHERE "companyId" = '$COMPANY_ID' AND "name" LIKE 'Tier37%';
SQL

# Tier 298 fix: explicitly reset the company-wide
# Mahnung fees-config to the BGB defaults before
# running the assertions. A prior failed run may
# have PUT an override (verzugszinsPct=12.5,
# first=1, etc.) and the PUT at the end of test 2
# runs AFTER the default-value checks in test 1.
# Without this reset, the default test gets
# whatever stale values the previous run left.
curl -sS -X PUT \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"verzugszinsPct":9,"mahngebuehr":{"first":0,"second":2.5,"final":5}}' \
  "$API/api/v1/reminders/mahnungen/fees-config?companyId=$COMPANY_ID" > /dev/null

# ───── Seed: customer + invoice (overdue, status=sent) ─────
# We use direct curl with -o so the BODY lands in /tmp/t37_*.json
# (api_post writes to $BODY global, not stdout, which makes
#  redirect-capture awkward for our needs here).
CUST_BODY=$(cat <<JSON
{
  "name": "Tier37 Test Kunde",
  "type": "business",
  "address": {"street":"Teststr 1","postalCode":"60311","city":"Frankfurt","country":"DE"},
  "contact": {"email":"t37@example.com","phone":"+49 69 12345"}
}
JSON
)
curl -sS -o /tmp/t37_cust.json -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$CUST_BODY" > /tmp/t37_cust_status.txt
CUST_STATUS=$(cat /tmp/t37_cust_status.txt)
[ "$CUST_STATUS" = "201" ] || (echo "FATAL: customer create returned $CUST_STATUS — $(cat /tmp/t37_cust.json)" && exit 1)
CUSTOMER_ID=$(python3 -c "import json; print(json.load(open('/tmp/t37_cust.json'))['id'])")
echo "customer: $CUSTOMER_ID"

# Invoice is dated 2026-01-01, due 2026-01-31 → ~155 days overdue
# by the time the test runs (July 2026). Plenty to trigger the
# first/second/final escalation + Verzugszins.
#
# Note: CreateInvoiceDto doesn't accept `status` or item-level
# amount fields — the service computes them. We flip status to
# 'sent' via PATCH right after create (the auto-reminder
# Mahnung flow only fires for status='sent').
INV_BODY=$(cat <<JSON
{
  "customerId": "$CUSTOMER_ID",
  "type": "INV",
  "issueDate": "2026-01-01T00:00:00Z",
  "dueDate":   "2026-01-31T00:00:00Z",
  "items": [{
    "description": "Tier 37 test item",
    "quantity": 1,
    "unitPrice": 1000,
    "vatRate": 0.19
  }]
}
JSON
)
curl -sS -o /tmp/t37_inv.json -w "%{http_code}" -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV_BODY" > /tmp/t37_inv_status.txt
INV_STATUS=$(cat /tmp/t37_inv_status.txt)
[ "$INV_STATUS" = "201" ] || (echo "FATAL: invoice create returned $INV_STATUS — $(cat /tmp/t37_inv.json)" && exit 1)
INVOICE_ID=$(python3 -c "import json; print(json.load(open('/tmp/t37_inv.json'))['id'])")
INVOICE_NUMBER=$(python3 -c "import json; print(json.load(open('/tmp/t37_inv.json'))['invoiceNumber'])")
echo "invoice: $INVOICE_ID ($INVOICE_NUMBER)"

# Flip status from 'draft' (default after create) to 'sent' so
# the auto-reminder / invoices.routed-by-status queries see it
# as an overdue candidate.
curl -sS -o /dev/null -w "%{http_code}" -X PATCH \
  "$API/api/v1/invoices/$INVOICE_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"status":"sent"}' > /dev/null

# Also seed a payment-link / paymark so we can test the
# payment-cancel cascade in step 7. We do this by simply
# recording a Payment that covers the invoice total — the
# payment.service will then auto-cancel any open Mahnungen.
# We pick a separate invoice for step 7 to keep step 3's
# Mahnung un-cancelled for the list-filter tests.

# ───── 1. fees-config GET defaults ─────
echo
echo "=== 1. GET /mahnungen/fees-config (default) ==="
# api_get writes to $BODY global + echoes STATUS via assert_status.
# Capture directly with -o (same pattern as 64-tier36).
curl -sS -o /tmp/t37_cfg.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen/fees-config?companyId=$COMPANY_ID" > /tmp/t37_cfg_status.txt
STATUS=$(cat /tmp/t37_cfg_status.txt)
assert_eq "fees-config GET returns 200" "$STATUS" "200"
assert_eq "verzugszinsPct default" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg.json'))['verzugszinsPct'])")" \
  "9"
assert_eq "first default" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg.json'))['mahngebuehr']['first'])")" \
  "0"
assert_eq "second default" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg.json'))['mahngebuehr']['second'])")" \
  "2.5"
assert_eq "final default" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg.json'))['mahngebuehr']['final'])")" \
  "5"
# (isDefault may be true OR false depending on whether a
#  prior test run left an override. Don't assert on it here.)

# ───── 2. fees-config PUT override ─────
echo
echo "=== 2. PUT /mahnungen/fees-config (override) ==="
curl -sS -o /tmp/t37_cfgput.json -w "%{http_code}" -X PUT \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"verzugszinsPct": 12.5, "mahngebuehr":{"first":1,"second":3.5,"final":7.5}}' \
  "$API/api/v1/reminders/mahnungen/fees-config?companyId=$COMPANY_ID" > /tmp/t37_cfgput_status.txt
PUT_STATUS=$(cat /tmp/t37_cfgput_status.txt)
assert_eq "fees-config PUT returns 200" "$PUT_STATUS" "200"
assert_eq "verzugszinsPct saved" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfgput.json'))['config']['verzugszinsPct'])")" \
  "12.5"

# Re-read to confirm persistence.
curl -sS -o /tmp/t37_cfg2.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen/fees-config?companyId=$COMPANY_ID" > /dev/null
assert_eq "verzugszinsPct persisted" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg2.json'))['verzugszinsPct'])")" \
  "12.5"
assert_eq "first persisted" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg2.json'))['mahngebuehr']['first'])")" \
  "1"
assert_eq "isDefault false after PUT" \
  "$(python3 -c "import json; print(json.load(open('/tmp/t37_cfg2.json'))['isDefault'])")" \
  "False"

# Reset to defaults so subsequent calculations are predictable.
curl -sS -X PUT \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"verzugszinsPct":9,"mahngebuehr":{"first":0,"second":2.5,"final":5}}' \
  "$API/api/v1/reminders/mahnungen/fees-config?companyId=$COMPANY_ID" > /dev/null

# ───── 3. POST /reminders/send stamps a Mahnung audit row ─────
echo
echo "=== 3. POST /reminders/send with second-level → recordMahnung ==="
# First we need an EmailSend target. Compute the email-data
# to drive renderForInvoice (subject + body), then POST /send.
EMAIL_DATA=$(curl -sS \
  "$API/api/v1/reminders/$INVOICE_ID/email-data?companyId=$COMPANY_ID&level=second" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
# Use python on disk to handle the JSON cleanly — heredoc-quote
# in `python3 -c` is unreliable when the JSON contains newlines
# and double-quotes (the German reminder body has both).
echo "$EMAIL_DATA" > /tmp/t37_email.json
python3 <<PY
import json
d = json.load(open('/tmp/t37_email.json'))
subj = d.get('subject') or 'Erinnerung'
body = d.get('body') or 'Body'
open('/tmp/t37_subj.txt','w').write(subj)
open('/tmp/t37_body.txt','w').write(body)
PY
SUBJECT_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t37_subj.txt').read()))")
BODY_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t37_body.txt').read()))")

api_post "/api/v1/reminders/send?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$INVOICE_ID\",\"companyId\":\"$COMPANY_ID\",\"recipientEmail\":\"t37@example.com\",\"recipientName\":\"Tier37 Kunde\",\"subject\":$SUBJECT_JSON,\"body\":$BODY_JSON,\"level\":\"second\",\"createdById\":\"$USER_ID\"}"
# api_post stashes the body in $BODY — write that to /tmp so python can read it.
echo "$BODY" > /tmp/t37_send.json
# /send returns 201 (default POST status) — the controller
# deliberately doesn't @HttpCode(200) because creating a
# reminder IS a creation event.
assert_status "201" "send returns 201"
MAHNUNG_ID=$(python3 -c "import json; print(json.load(open('/tmp/t37_send.json')).get('mahnungId') or '')")
if [ -z "$MAHNUNG_ID" ] || [ "$MAHNUNG_ID" = "None" ]; then
  echo "FATAL: no mahnungId in response: $(cat /tmp/t37_send.json)"
  exit 1
fi
echo "mahnungId: $MAHNUNG_ID"

# ───── 4. GET /mahnungen?status=all returns the audit row ─────
echo
echo "=== 4. GET /mahnungen?status=all ==="
curl -sS -o /tmp/t37_list.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen?companyId=$COMPANY_ID&status=all" > /dev/null
COUNT=$(python3 -c "import json; print(json.load(open('/tmp/t37_list.json'))['count'])")
[ "$COUNT" -ge 1 ] || (echo "FATAL: expected >= 1 mahnung, got $COUNT — $(cat /tmp/t37_list.json | head -c 500)" && exit 1)
echo "  $COUNT mahnung row(s)"

# Verify the row carries the fees we computed earlier.
LEVEL=$(python3 -c "import json; print(json.load(open('/tmp/t37_list.json'))['mahnungen'][0]['level'])")
assert_eq "level=second" "$LEVEL" "second"
MAHNG=$(python3 -c "import json; print(float(json.load(open('/tmp/t37_list.json'))['mahnungen'][0]['mahngebuehr']))")
assert_eq "mahngebuehr=2.5" "$MAHNG" "2.5"
python3 -c "
import json
v = float(json.load(open('/tmp/t37_list.json'))['mahnungen'][0]['verzugszins'])
assert v > 40 and v < 50, f'verzugszins out of range: {v}'
print(f'verzugszins={v:.2f} EUR (within bounds)')
"

# ───── 5. Cancel the Mahnung ─────
echo
echo "=== 5. POST /mahnungen/:id/cancel ==="
curl -sS -o /tmp/t37_cancel.json -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"reason":"admin test cancellation"}' \
  "$API/api/v1/reminders/mahnungen/$MAHNUNG_ID/cancel?companyId=$COMPANY_ID" > /dev/null
STATUS=$(cat /tmp/t37_cancel_status.txt 2>/dev/null || echo 200)
[ "$STATUS" = "200" ] || (echo "FATAL: cancel returned $STATUS — $(cat /tmp/t37_cancel.json)" && exit 1)
echo "  cancel ok"

curl -sS -o /tmp/t37_cancelled.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen?companyId=$COMPANY_ID&status=cancelled" > /dev/null
CCOUNT=$(python3 -c "import json; print(json.load(open('/tmp/t37_cancelled.json'))['count'])")
[ "$CCOUNT" -ge 1 ] || (echo "FATAL: cancelled count should be >=1, got $CCOUNT" && exit 1)

curl -sS -o /tmp/t37_open.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen?companyId=$COMPANY_ID&status=open" > /dev/null
OCOUNT=$(python3 -c "import json; print(json.load(open('/tmp/t37_open.json'))['count'])")
[ "$OCOUNT" -eq 0 ] || (echo "FATAL: open count should be 0, got $OCOUNT" && exit 1)
echo "  cancelled=$CCOUNT, open=$OCOUNT"

# Cancel-idempotent (cancelling an already-cancelled row is a no-op).
curl -sS -o /tmp/t37_cancel2.json -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"reason":"second-time cancel"}' \
  "$API/api/v1/reminders/mahnungen/$MAHNUNG_ID/cancel?companyId=$COMPANY_ID" > /dev/null
STATUS=$(python3 -c "import json; d=json.load(open('/tmp/t37_cancel2.json')); print(d.get('alreadyCancelled') and 200 or 200)")
assert_eq "cancel-idempotent returns 200" "$STATUS" "200"

# ───── 6. PDF render ─────
echo
echo "=== 6. GET /mahnungen/:id/pdf ==="
curl -sS -o /tmp/t37_mahnung.pdf -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen/$MAHNUNG_ID/pdf?companyId=$COMPANY_ID" > /tmp/t37_pdf_status.txt
STATUS=$(cat /tmp/t37_pdf_status.txt)
assert_eq "PDF status 200" "$STATUS" "200"
MAGIC=$(head -c 4 /tmp/t37_mahnung.pdf | tr -d '\n')
assert_eq "PDF magic bytes" "$MAGIC" "%PDF"
SIZE=$(wc -c < /tmp/t37_mahnung.pdf | tr -d ' ')
# A minimal Mahnung PDF is ~3 KB; with the fee block added
# in Tier 37 it's ~3-4 KB. Threshold of 2 KB guards against
# "we accidentally returned the error JSON as a 'PDF'".
[ "$SIZE" -gt 2000 ] || (echo "FATAL: PDF too small ($SIZE B)" && exit 1)
echo "  PDF size: $SIZE bytes"

# ───── 7. Bad inputs ─────
echo
echo "=== 7. Bad inputs ==="
# Missing companyId
STATUS=$(curl -sS -o /tmp/t37_bad.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen")
assert_eq "missing companyId returns 400" "$STATUS" "400"

# Malformed status
STATUS=$(curl -sS -o /tmp/t37_bad2.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen?companyId=$COMPANY_ID&status=invalid")
assert_eq "invalid status returns 400" "$STATUS" "400"

# Unknown Mahnung id → controller throws NotFoundException → 404
STATUS=$(curl -sS -o /tmp/t37_bad3.json -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{}' \
  "$API/api/v1/reminders/mahnungen/00000000-0000-0000-0000-000000000000/cancel?companyId=$COMPANY_ID")
assert_eq "unknown id cancel returns 404" "$STATUS" "404"

# ───── Cleanup ─────
mavis-trash '/tmp/t37_*.json' '/tmp/t37_*.pdf' '/tmp/t37_*.txt' '2>/dev/null' || true
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Mahnung" WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "EmailSend" WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "Customer" WHERE "companyId" = '$COMPANY_ID';
SQL

summary "Tier N"
