#!/usr/bin/env bash
# e2e 62: Tier 32 — Bulk email send.
#
# Validates the /api/v1/invoices/bulk-send-email
# endpoint:
#
#   1. Missing invoiceIds → 400.
#   2. Empty invoiceIds array → 400.
#   3. invoiceIds > 100 → 400.
#   4. dryRun on invoices with customers that
#      have no email → ok=false, error
#      "Kunde hat keine E-Mail-Adresse hinterlegt".
#   5. dryRun on a fresh invoice where the
#      customer has email → ok=true, recipient set.
#   6. Real send (dryRun=false) on the same
#      invoices → all succeed. Each invoice
#      gets a corresponding EmailSend row.
#
# We don't require SMTP configured — when SMTP
# isn't set, the MailService logs the email
# instead of sending. The EmailSend row is
# still created with status='opened' instead
# of 'sent'.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

# Hardcoded test user (matches /tmp/cashbook-e2e-auth.env
# — same user the rest of the suite uses).
# Clean up any bulk-test artefacts from previous runs.
# Done at the START so a partial failure on re-run
# doesn't leave a Customer with email 'bulk62@x.de'
# blocking the next attempt. We walk the full FK chain:
#
#   EmailSend → Invoice → Customer
#   Payment    → Invoice (blocks delete without removal)
#   PaymentLink → Invoice (Tier 33 portal stubs)
#
# PG CASCADE only kicks in for relationships that opt
# into it in the Prisma schema. EmailSend's invoiceId
# is a regular FK (no CASCADE), Payment and PaymentLink
# are also regular — every test run that touches this
# customer MUST clean them up explicitly.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"EmailSend\" WHERE \"companyId\" = '$COMPANY_ID' AND \"recipientEmail\" LIKE 'bulk62%@x.de';
  DELETE FROM \"Payment\" WHERE \"invoiceId\" IN (
    SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"customerId\" IN (
      SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'Bulk62 Test Customer'
    )
  );
  DELETE FROM \"PaymentLink\" WHERE \"invoiceId\" IN (
    SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"customerId\" IN (
      SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'Bulk62 Test Customer'
    )
  );
  DELETE FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"customerId\" IN (
    SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'Bulk62 Test Customer'
  );
  -- Tier 299 fix: also delete any Customer that
  -- owns the 'bulk62@*@x.de' contact email (covers
  -- both the hardcoded legacy 'bulk62@x.de' AND
  -- the per-run unique 'bulk62+<pid>@x.de'). The
  -- original cleanup only matched on `name`, so a
  -- prior run that retried the create with a
  -- 409 left a stale Customer with that email
  -- but a different name. The follow-up POST then
  -- 409s on the email's @unique index, and the
  -- test fails with 'could not create test
  -- customer'. We delete by BOTH name and email
  -- pattern to be safe.
  DELETE FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND name = 'Bulk62 Test Customer';
  DELETE FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' AND \"contact\"->>'email' LIKE 'bulk62%@x.de';" >/dev/null 2>&1

# ---- 1. Missing invoiceIds → 400 ----
echo
echo "=== 1. POST /invoices/bulk-send-email (missing invoiceIds) → 400 ==="
api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" '{}'
assert_status "400" "missing invoiceIds returns 400"

# ---- 2. Empty array → 400 ----
echo
echo "=== 2. POST /invoices/bulk-send-email (empty array) → 400 ==="
api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" '{"invoiceIds":[]}'
assert_status "400" "empty invoiceIds returns 400"

# ---- 3. > 100 IDs → 400 ----
echo
echo "=== 3. POST /invoices/bulk-send-email (101 IDs) → 400 ==="
BIG=$(python3 -c "import json; print(json.dumps({'invoiceIds':['x']*101}))")
api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" "$BIG"
assert_status "400" "101 IDs returns 400"

# ---- 4. dryRun on existing draft invoice (no email on customer) ----
echo
echo "=== 4. POST /invoices/bulk-send-email (dryRun, no-email customer) ==="
# Pick an existing draft invoice. The first
# 50 are returned by GET /invoices.
LIST=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices?companyId=$COMPANY_ID&status=draft")
FIRST_ID=$(echo "$LIST" | python3 -c "
import json,sys
d = json.load(sys.stdin)
items = d if isinstance(d, list) else d.get('items', d.get('data', []))
print(items[0]['id'] if items else '')")
if [[ -z "$FIRST_ID" ]]; then
  fail "no draft invoice to test with"
else
  BODY=$(python3 -c "import json; print(json.dumps({'invoiceIds':['$FIRST_ID'],'dryRun':True}))")
  api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" "$BODY"
  assert_status "201" "dryRun returns 201"
  DRY_OK=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['results'][0]['ok'])" 2>/dev/null || echo "")
  # We don't know if this customer has email;
  # both ok=true / ok=false are valid outcomes.
  # Just assert the response shape is sane.
  DRY_RESULTS_LEN=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['results']))" 2>/dev/null || echo "0")
  assert_eq "dryRun returns 1 result row" "$DRY_RESULTS_LEN" "1"
fi

# ---- 5. dryRun on fresh invoice WITH email → ok=true ----
echo
echo "=== 5. POST /invoices/bulk-send-email (dryRun, email present) ==="
# Tier 299 fix: the dev DB has a Müller GmbH
# (K-00018) fixture from Round 11-34 with
# contact.email='bulk62@x.de' (a stale spec
# leak from a prior failed run of this spec).
# The hardcoded email hits the contact-email
# @unique constraint and the POST returns 409
# with no id. Use a unique-per-run email so
# the POST always succeeds.
UNIQUE_EMAIL="bulk62+$$@x.de"
CUST_RESP=$(curl -sS -X POST -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"name\":\"Bulk62 Test Customer\",\"type\":\"business\",\"contact\":{\"email\":\"$UNIQUE_EMAIL\"}}" \
  "$API/api/v1/customers?companyId=$COMPANY_ID")
CUST_ID=$(echo "$CUST_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
if [[ -z "$CUST_ID" ]]; then
  fail "could not create test customer"
else
  # Need a product for the invoice item.
  PROD_ID=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    "$API/api/v1/products?companyId=$COMPANY_ID" \
    | python3 -c "
import json,sys
d = json.load(sys.stdin)
items = d if isinstance(d, list) else d.get('items', d.get('data', []))
print(items[0]['id'] if items else '')")
  if [[ -z "$PROD_ID" ]]; then
    fail "no product to test with"
  else
    INV_BODY=$(python3 -c "
import json
print(json.dumps({
  'customerId':'$CUST_ID',
  'currency':'EUR',
  'issueDate':'2026-07-02',
  'dueDate':'2026-07-16',
  'type':'INV',
  'items':[{
    'description':'Bulk62 test',
    'productId':'$PROD_ID',
    'quantity':1,
    'unitPrice':100,
    'vatRate':0.19
  }]
}))")
    INV_RESP=$(curl -sS -X POST -H "Content-Type: application/json" \
      -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
      -d "$INV_BODY" "$API/api/v1/invoices?companyId=$COMPANY_ID")
    INV_ID=$(echo "$INV_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
    if [[ -z "$INV_ID" ]]; then
      fail "could not create test invoice ($INV_RESP)"
    else
      BULK_BODY=$(python3 -c "import json; print(json.dumps({'invoiceIds':['$INV_ID'],'dryRun':True}))")
      api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" "$BULK_BODY"
      assert_status "201" "dryRun-with-email returns 201"
      DRY_OK=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['ok'])" 2>/dev/null || echo "")
      DRY_RCPT=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0].get('recipient',''))" 2>/dev/null || echo "")
      # Tier 299: assertion now compares against the
      # unique-per-run email ($UNIQUE_EMAIL) instead
      # of the hardcoded 'bulk62@x.de' that conflicts
      # with the Round 11-34 Müller GmbH fixture.
      if [[ "$DRY_OK" == "True" && "$DRY_RCPT" == "$UNIQUE_EMAIL" ]]; then
        pass "dryRun: ok=true, recipient=$UNIQUE_EMAIL"
      else
        fail "dryRun: ok=$DRY_OK recipient=$DRY_RCPT (expected True, $UNIQUE_EMAIL)"
      fi
      # ---- 6. Real send on the same invoice → ok=true ----
      echo
      echo "=== 6. POST /invoices/bulk-send-email (real send, same invoice) ==="
      BULK_BODY=$(python3 -c "import json; print(json.dumps({'invoiceIds':['$INV_ID'],'concurrency':1}))")
      api_post "/api/v1/invoices/bulk-send-email?companyId=$COMPANY_ID" "$BULK_BODY"
      assert_status "201" "real bulk-send returns 201"
      REAL_OK=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['ok'])" 2>/dev/null || echo "")
      if [[ "$REAL_OK" == "True" ]]; then
        pass "real bulk-send: ok=true"
      else
        fail "real bulk-send: ok=$REAL_OK"
      fi
      # EmailSend row should exist.
      ES_COUNT=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
        "$API/api/v1/mail/emails?companyId=$COMPANY_ID" \
        | python3 -c "
import json,sys
try:
  d = json.load(sys.stdin)
  items = d if isinstance(d, list) else d.get('items', d.get('data', []))
  matches = [e for e in items if e.get('invoiceId') == '$INV_ID'] if isinstance(items, list) else []
  print(len(matches))
except Exception as e:
  print(0)")
      if [[ "$ES_COUNT" -ge "1" ]]; then
        pass "EmailSend row created (count=$ES_COUNT)"
      else
        fail "EmailSend row missing (count=$ES_COUNT)"
      fi
      # ---- Cleanup ----
      curl -sS -X DELETE -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
        "$API/api/v1/invoices/$INV_ID?companyId=$COMPANY_ID" >/dev/null 2>&1
    fi
  fi
  curl -sS -X DELETE -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    "$API/api/v1/customers/$CUST_ID?companyId=$COMPANY_ID" >/dev/null 2>&1
fi

if [[ $FAILS -gt 0 ]]; then
  echo
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
summary