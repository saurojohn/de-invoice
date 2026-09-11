#!/usr/bin/env bash
# e2e 82: Tier 55 — Mahnung PDF with "Skonto-Fenster
# abgelaufen" note.
#
# Validates:
#   1. A Mahnung PDF for an invoice WITH skontoPercent
#      + skontoDays carries the bold note:
#      "Hinweis: das X% Skonto-Fenster (bis DD.MM.YYYY)
#      ist abgelaufen."
#   2. The Skonto-with date is correct:
#      issueDate + skontoDays.
#   3. A Mahnung PDF for an invoice WITHOUT Skonto
#      has no Skonto note.
#   4. A Mahnung PDF for an invoice where the Skonto
#      window has NOT yet expired has no note
#      (no premature warning to the customer).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# ───── 0. Wipe prior tier-55 fixtures ─────
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Mahnung" WHERE id LIKE 'e2e00055-%';
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT v.id FROM "Voucher" v
  LEFT JOIN "Invoice" i ON i."voucherRefId" = v.id
  WHERE i."invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "Voucher" WHERE id IN (
  SELECT v.id FROM "Voucher" v
  LEFT JOIN "Invoice" i ON i."voucherRefId" = v.id
  WHERE i."invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%';
SQL

# ───── 1. Seed customer ─────
CUST_ID=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1")
[[ -n "$CUST_ID" ]] || (echo "FATAL: customer not seeded" && exit 1)
pass "seeded customer: $CUST_ID"

# Helper: create an overdue invoice + a Mahnung row +
# fetch the PDF. Returns the PDF text.
fetch_mahnung_pdf() {
  local inv_id="$1"
  local mahn_id="$2"
  docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Mahnung" (id, "companyId", "invoiceId", level, "daysOverdue",
  "neueFrist", "mahngebuehr", "verzugszins",
  "totalDue", "recipientEmail", "recipientName", "createdAt")
VALUES ('$mahn_id', '$COMPANY_ID', '$inv_id', 'first', 30,
  '2026-07-15', 5.00, 2.50, 119.00, 'test@example.com', 'Test Customer', now());
SQL
  curl -s "http://localhost:3001/api/v1/reminders/mahnungen/$mahn_id/pdf?companyId=$COMPANY_ID" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -o "/tmp/tier55-mahnung-$mahn_id.pdf"
  python3 -c "
import pypdf
r = pypdf.PdfReader('/tmp/tier55-mahnung-$mahn_id.pdf')
out = ''
for p in r.pages:
    out += p.extract_text() or ''
print(out)
"
}

# ───── 2. Skonto-expired invoice → PDF has the note ─────
echo
note "=== 1. Skonto window EXPIRED → note on PDF ==="
# issueDate=2026-05-01, skontoDays=7 → Skonto expired 2026-05-08.
# Today is 2026-07-09 → definitely expired.
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-05-01T00:00:00.000Z\",\"dueDate\":\"2026-05-15T00:00:00.000Z\",\"skontoPercent\":2,\"skontoDays\":7,\"items\":[{\"description\":\"Skonto Mahnung test\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create Skonto-expired invoice"
INV1_ID=$(json_field "$BODY" id)

PDF_TEXT=$(fetch_mahnung_pdf "$INV1_ID" "e2e00055-0000-0000-0000-000000000001")
echo "$PDF_TEXT" | grep -q "Hinweis: das 2% Skonto-Fenster (bis 08.05.2026) ist abgelaufen" \
  && pass "Skonto-missed note on PDF" \
  || fail "Skonto-missed note missing (expected: Hinweis: das 2% Skonto-Fenster (bis 08.05.2026) ist abgelaufen)"

# ───── 3. No-Skonto invoice → no note ─────
echo
note "=== 2. No Skonto on invoice → no note on PDF ==="
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"2026-05-01T00:00:00.000Z\",\"dueDate\":\"2026-05-15T00:00:00.000Z\",\"items\":[{\"description\":\"No Skonto\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create no-Skonto invoice"
INV2_ID=$(json_field "$BODY" id)

PDF2_TEXT=$(fetch_mahnung_pdf "$INV2_ID" "e2e00055-0000-0000-0000-000000000002")
echo "$PDF2_TEXT" | grep -q "Skonto-Fenster" \
  && fail "no-Skonto invoice has Skonto note" \
  || pass "no-Skonto invoice has no Skonto note"

# ───── 4. Skonto window NOT yet expired → no note ─────
echo
note "=== 3. Skonto window still OPEN → no premature note ==="
# issueDate = today, skontoDays = 30 → Skonto window open
# for another 30 days. Mahnung should NOT pre-announce
# the missed-Skonto state.
TODAY=$(date -u +%Y-%m-%dT00:00:00.000Z)
# But we need dueDate in the past so it's overdue.
# Override dueDate to a past date; the Mahnung flow
# only checks daysOverdue from dueDate, not from
# issueDate.
api_post "/api/v1/invoices?companyId=$COMPANY_ID" \
  "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"$TODAY\",\"dueDate\":\"2026-06-01T00:00:00.000Z\",\"skontoPercent\":2,\"skontoDays\":30,\"items\":[{\"description\":\"Skonto-open\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status "201" "create Skonto-still-open invoice"
INV3_ID=$(json_field "$BODY" id)

PDF3_TEXT=$(fetch_mahnung_pdf "$INV3_ID" "e2e00055-0000-0000-0000-000000000003")
echo "$PDF3_TEXT" | grep -q "Skonto-Fenster" \
  && fail "Skonto-still-open invoice has premature note" \
  || pass "Skonto-still-open invoice has no note"

# ───── 5. Cleanup ─────
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Mahnung" WHERE id LIKE 'e2e00055-%';
DELETE FROM "Payment" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%'
);
DELETE FROM "Invoice" WHERE "companyId" = '$COMPANY_ID' AND "invoiceNumber" LIKE 'Tier55%';
SQL

summary
exit $?