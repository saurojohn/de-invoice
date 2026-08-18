#!/usr/bin/env bash
# e2e 68: Tier 40 — Mahnung PDF carries DATEV costCenter + costObject.
#
# Validates:
#   1. Setting invoice.costCenter + costObject (via SQL after create,
#      since CreateInvoiceDto already accepts them — see e2e 67 — but
#      the Tier-37 e2e path uses `/send` and stores the audit row).
#      Manual /send stamps a Mahnung row.
#   2. GET /reminders/mahnungen/:id/pdf streams a PDF whose text
#      layer includes both:
#        a) the word "Kostenstelle:" + the costCenter value
#        b) the word "Kostenträger:" + the costObject value
#      We verify with `pdftotext -layout` if available, falling back
#      to the magic-bytes check + size threshold if pdftotext is not
#      installed locally.
#   3. PDF without costCenter still renders cleanly (no error,
#      just no cost-center line in the body).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# Wipe any prior Tier-40 fixture customer.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Mahnung"    WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "EmailSend"  WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "Payment"    WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID'));
DELETE FROM "PaymentLink" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID'));
DELETE FROM "Invoice"    WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Customer"   WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID';
SQL

# ───── Seed customer + invoice (overdue) ─────
CUST_BODY='{"name":"Tier40 Test Kunde","type":"business","address":{"street":"t40str 1","postalCode":"60311","city":"Frankfurt","country":"DE"},"contact":{"email":"t40@example.com","phone":"+49 69 40404"}}'
curl -sS -o /tmp/t40_cust.json -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$CUST_BODY" > /tmp/t40_cust_status.txt
[ "$(cat /tmp/t40_cust_status.txt)" = "201" ] || (echo "FATAL cust=$(cat /tmp/t40_cust_status.txt) — $(cat /tmp/t40_cust.json | head -c 200)" && exit 1)
CUSTOMER_ID=$(python3 -c "import json; print(json.load(open('/tmp/t40_cust.json'))['id'])")
echo "customer: $CUSTOMER_ID"

# Create the invoice with costCenter in the payload (we now
# accept it on the create DTO — verified by the Tier 39 e2e).
INV_BODY=$(cat <<JSON
{
  "customerId": "$CUSTOMER_ID",
  "type": "INV",
  "issueDate": "2026-01-01T00:00:00Z",
  "dueDate":   "2026-01-31T00:00:00Z",
  "costCenter": "VERTRIEB-100",
  "costObject": "PROJ-2026-Q3-OKT",
  "items": [{"description":"Tier 40 test item","quantity":1,"unitPrice":100,"vatRate":0.19}]
}
JSON
)
curl -sS -o /tmp/t40_inv.json -w "%{http_code}" -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV_BODY" > /tmp/t40_inv_status.txt
[ "$(cat /tmp/t40_inv_status.txt)" = "201" ] || (echo "FATAL inv=$(cat /tmp/t40_inv_status.txt) — $(cat /tmp/t40_inv.json | head -c 300)" && exit 1)
INVOICE_ID=$(python3 -c "import json; print(json.load(open('/tmp/t40_inv.json'))['id'])")
echo "invoice: $INVOICE_ID"

# Sanity: cc/co persisted at the JSON level.
CC=$(python3 -c "import json; print(json.load(open('/tmp/t40_inv.json'))['costCenter'])")
CO=$(python3 -c "import json; print(json.load(open('/tmp/t40_inv.json'))['costObject'])")
assert_eq "invoice costCenter persisted at create" "$CC" "VERTRIEB-100"
assert_eq "invoice costObject persisted at create" "$CO" "PROJ-2026-Q3-OKT"

# ───── Manual /send → records Mahnung with cost center stamps ─────
echo
echo "=== 1. POST /reminders/send stamps Mahnung ==="
EMAIL_DATA=$(curl -sS \
  "$API/api/v1/reminders/$INVOICE_ID/email-data?companyId=$COMPANY_ID&level=second" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
# Use a file-based python so the JSON (which may contain
# newlines from the German reminder body) doesn't break
# the bash heredoc.
echo "$EMAIL_DATA" > /tmp/t40_email1.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/t40_email1.json'))
open('/tmp/t40_subj.txt','w').write(d.get('subject') or 'E')
open('/tmp/t40_body.txt','w').write(d.get('body') or 'X')
PY
SUBJECT_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t40_subj.txt').read()))")
BODY_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t40_body.txt').read()))")

api_post "/api/v1/reminders/send?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$INVOICE_ID\",\"companyId\":\"$COMPANY_ID\",\"recipientEmail\":\"t40@example.com\",\"recipientName\":\"Tier40 Kunde\",\"subject\":$SUBJECT_JSON,\"body\":$BODY_JSON,\"level\":\"second\",\"createdById\":\"$USER_ID\"}"
assert_status "201" "send returns 201"
echo "$BODY" > /tmp/t40_send.json
MAHNUNG_ID=$(python3 -c "import json; print(json.load(open('/tmp/t40_send.json'))['mahnungId'])")
[ -n "$MAHNUNG_ID" ] && [ "$MAHNUNG_ID" != "None" ] || (echo "FATAL: no mahnungId: $(cat /tmp/t40_send.json)" && exit 1)
echo "  mahnungId: $MAHNUNG_ID"

# ───── 2. GET /reminders/mahnungen/:id/pdf renders cost center ─────
echo
echo "=== 2. PDF contains 'Kostenstelle: VERTRIEB-100' + 'Kostenträger: PROJ-2026-Q3-OKT' ==="
curl -sS -o /tmp/t40_mahnung.pdf -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen/$MAHNUNG_ID/pdf?companyId=$COMPANY_ID" > /tmp/t40_pdf_status.txt
PDF_STATUS=$(cat /tmp/t40_pdf_status.txt)
assert_eq "PDF status 200" "$PDF_STATUS" "200"
PDF_MAGIC=$(head -c 4 /tmp/t40_mahnung.pdf)
assert_eq "PDF magic bytes" "$PDF_MAGIC" "%PDF"

# Extract text via python pypdf (pure-python, ships with the
# image — no poppler / pdftotext binary needed). We pin
# specific German strings since the PDF generator emits
# exactly "Kostenstelle: <value>" / "Kostenträger: <value>"
# on a single line. If pypdf isn't available we fall back
# to a size-only smoke check.
if python3 -c "import pypdf" 2>/dev/null; then
  python3 - <<'PY'
import pypdf, sys
r = pypdf.PdfReader('/tmp/t40_mahnung.pdf')
text = '\n'.join(p.extract_text() or '' for p in r.pages)
open('/tmp/t40_mahnung.txt','w').write(text)
if 'Kostenstelle: VERTRIEB-100' not in text:
    print('FATAL: Kostenstelle not in PDF text')
    sys.exit(1)
if 'Kostenträger: PROJ-2026-Q3-OKT' not in text:
    print('FATAL: Kostenträger not in PDF text')
    sys.exit(1)
print('  Kostenstelle + Kostenträger both present in PDF text')
PY
else
  SIZE=$(wc -c < /tmp/t40_mahnung.pdf | tr -d ' ')
  [ "$SIZE" -gt 2000 ] || (echo "FATAL: PDF too small ($SIZE B)" && exit 1)
  echo "  pypdf missing - size threshold: ${SIZE}B"
fi

# ───── 3. PDF for an invoice WITHOUT costCenter stamps (no extra line) ─────
echo
echo "=== 3. PDF without costCenter stamps renders cleanly (no 'Kostenstelle:' line) ==="
# Create a 2nd invoice with no costCenter.
INV2_BODY=$(cat <<JSON
{
  "customerId": "$CUSTOMER_ID",
  "type": "INV",
  "issueDate": "2026-01-01T00:00:00Z",
  "dueDate":   "2026-01-31T00:00:00Z",
  "items": [{"description":"No-cc test","quantity":1,"unitPrice":50,"vatRate":0.19}]
}
JSON
)
curl -sS -o /tmp/t40_inv2.json -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV2_BODY" > /dev/null
INVOICE_ID2=$(python3 -c "import json; print(json.load(open('/tmp/t40_inv2.json'))['id'])")
# Send / generate Mahnung on it.
EMAIL2=$(curl -sS \
  "$API/api/v1/reminders/$INVOICE_ID2/email-data?companyId=$COMPANY_ID&level=first" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
echo "$EMAIL2" > /tmp/t40_email2.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/t40_email2.json'))
open('/tmp/t40_subj2.txt','w').write(d.get('subject') or 'E')
open('/tmp/t40_body2.txt','w').write(d.get('body') or 'X')
PY
SUBJECT2_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t40_subj2.txt').read()))")
BODY2_JSON=$(python3 -c "import json; print(json.dumps(open('/tmp/t40_body2.txt').read()))")
api_post "/api/v1/reminders/send?companyId=$COMPANY_ID" \
  "{\"invoiceId\":\"$INVOICE_ID2\",\"companyId\":\"$COMPANY_ID\",\"recipientEmail\":\"t40@example.com\",\"recipientName\":\"Tier40 Kunde\",\"subject\":$SUBJECT2_JSON,\"body\":$BODY2_JSON,\"level\":\"first\",\"createdById\":\"$USER_ID\"}"
echo "$BODY" > /tmp/t40_send2.json
MAHNUNG_ID2=$(python3 -c "import json; print(json.load(open('/tmp/t40_send2.json'))['mahnungId'])")
# Download PDF and check size + magic.
curl -sS -o /tmp/t40_mahnung2.pdf -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reminders/mahnungen/$MAHNUNG_ID2/pdf?companyId=$COMPANY_ID" > /dev/null
assert_eq "PDF2 magic bytes" "$(head -c 4 /tmp/t40_mahnung2.pdf)" "%PDF"
if command -v pdftotext >/dev/null 2>&1; then
  pdftotext -layout /tmp/t40_mahnung2.pdf /tmp/t40_mahnung2.txt
  if grep -q "Kostenstelle:" /tmp/t40_mahnung2.txt; then
    echo "FAIL: 'Kostenstelle:' line appeared on PDF without cc stamp"
    exit 1
  fi
  echo "  ✓ no Kostenstelle line (cc=None) ✓"
fi

# ───── Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Mahnung"    WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "EmailSend"  WHERE "companyId" = '$COMPANY_ID';
DELETE FROM "Payment"    WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID'));
DELETE FROM "PaymentLink" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID'));
DELETE FROM "Invoice"    WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Customer"   WHERE "name" LIKE 'Tier40%' AND "companyId" = '$COMPANY_ID';
SQL

summary "Tier N"
