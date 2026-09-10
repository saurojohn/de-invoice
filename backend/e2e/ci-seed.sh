#!/bin/bash
# CI seed (Tier 248) — sets up the test database for the
# backend e2e suite in GitHub Actions.
#
# Why this exists:
#   - 127 of 169 e2e tests assume a postgres container
#     named `de-invoice-postgres` reachable via
#     `docker exec de-invoice-postgres psql ...`.
#   - GitHub Actions `services:` containers are isolated
#     and not visible to `docker exec` on the runner —
#     so the e2e job has to launch a sidecar postgres
#     container in a step, not as a service.
#   - The e2e tests assume an admin user
#     `info@shleder.de / Test1234!` already exists, and
#     the company `SH Leder GmbH` is seeded with a
#     known taxId + German address. /auth/register
#     creates the user+company but the company taxId
#     is null and the address is empty — Tier 115
#     (XRechnung) and other tests fail on that.
#
# This script is idempotent — safe to re-run if the
# CI job crashes partway.
#
# Usage (in CI):
#   docker run -d --name de-invoice-postgres \
#     -e POSTGRES_USER=de_invoice \
#     -e POSTGRES_PASSWORD=de_invoice_pass \
#     -e POSTGRES_DB=de_invoice \
#     -p 5432:5432 \
#     postgres:16-alpine
#   # wait for ready
#   bash backend/e2e/ci-seed.sh
#
# Environment overrides:
#   API           - backend URL (default http://localhost:3001)
#   PG_CONTAINER  - postgres container name (default de-invoice-postgres)
#   PG_USER       - postgres user (default de_invoice)
#   PG_DB         - postgres database (default de_invoice)
#   TEST_EMAIL / TEST_PASSWORD - admin creds (default info@shleder.de / Test1234!)
#   COMPANY_NAME  - company name (default SH Leder GmbH)
#   TAX_ID        - company taxId (default 123/456/78901)
set -euo pipefail

API="${API:-http://localhost:3001}"
PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"
PG_USER="${PG_USER:-de_invoice}"
PG_DB="${PG_DB:-de_invoice}"
EMAIL="${TEST_EMAIL:-info@shleder.de}"
PASSWORD="${TEST_PASSWORD:-Test1234!}"
COMPANY_NAME="${COMPANY_NAME:-SH Leder GmbH}"
TAX_ID="${TAX_ID:-123/456/78901}"

# Helper: run a SQL command against the test postgres.
# Uses `docker exec -i` so that stdin (heredoc or pipe)
# is forwarded to psql. Without `-i`, psql's stdin
# is closed and silent — the SQL is read as empty.
psql_test() {
  # Tier 347: -v ON_ERROR_STOP=1 is MANDATORY here. Without it psql
  # reports an ERROR on stderr, CONTINUES with the next statement, and
  # still exits 0 — so a broken INSERT is silently skipped and the
  # `ok "... seeded"` line below it prints a green checkmark anyway.
  # That is how four dead INSERTs (RecurringInvoiceItem.sortOrder,
  # 2x Invoice.date/totalNet/totalGross, CashBookClose) survived in
  # this file undetected, permanently starving the specs that depend
  # on those rows. With ON_ERROR_STOP the seed fails fast and CI says
  # exactly which statement broke.
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" "$@"
}

note() { echo "▶ $*"; }
ok()   { echo "✔ $*"; }

# 1. Wait for the backend to be reachable.
note "Waiting for backend at $API ..."
for i in $(seq 1 30); do
  H=$(curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/health" 2>/dev/null || true)
  if [ "$H" = "200" ]; then ok "backend up (HTTP $H)"; break; fi
  sleep 1
done
if [ "$H" != "200" ]; then
  echo "FATAL: backend not reachable at $API/api/v1/health" >&2
  exit 1
fi

# 2. Try to register the admin user. If the user
#    already exists (e.g. CI re-ran on a warm cache
#    or someone re-ran the seed), the register
#    endpoint returns 400 with a generic message —
#    we treat that as "already seeded" and continue.
REGISTER_RESP=$(curl -sS -X POST "$API/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"companyName\":\"$COMPANY_NAME\"}" \
  -w "\n%{http_code}")
# `head -n -1` is GNU-only (macOS BSD head fails); use sed.
REGISTER_BODY=$(echo "$REGISTER_RESP" | sed '$d')
REGISTER_CODE=$(echo "$REGISTER_RESP" | tail -n 1)
note "register HTTP $REGISTER_CODE"
if [ "$REGISTER_CODE" = "201" ] || [ "$REGISTER_CODE" = "200" ]; then
  ok "registered $EMAIL"
elif echo "$REGISTER_BODY" | grep -qi "fehlgeschlagen\|already\|existiert"; then
  ok "user already exists (idempotent re-seed)"
else
  echo "FATAL: register failed: $REGISTER_BODY" >&2
  exit 1
fi

# 3. Look up the user + company. The login
#    response gives us both id and companyId.
LOGIN=$(curl -sS -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
USER_ID=$(echo "$LOGIN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
COMPANY_ID=$(echo "$LOGIN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('companyId',''))")
if [ -z "$USER_ID" ] || [ -z "$COMPANY_ID" ]; then
  echo "FATAL: login did not return user/company: $LOGIN" >&2
  exit 1
fi
ok "user $USER_ID, company $COMPANY_ID"

# 4. Update the company to the SH Leder test
#    fixtures (taxId + German address + legalName).
#    The /auth/register endpoint leaves taxId
#    null and address empty — the XRechnung (Tier
#    115), UStJA (Tier 107), and other e2e tests
#    assume those fields are populated.
note "seeding company taxId + address ..."
psql_test -c "
  UPDATE \"Company\"
  SET \"taxId\"='$TAX_ID',
      address='{\"street\":\"Musterstraße 1\",\"city\":\"Stuttgart\",\"postalCode\":\"70173\",\"country\":\"Deutschland\"}'::jsonb,
      \"legalName\"='$COMPANY_NAME',
      \"invoicePrefix\"='INV-',
      -- NULL out bankInfo so the Tier 164
      -- fees-config test sees the post-2023
      -- default (5/5/10) instead of any
      -- pre-seeded mahnungConfig override.
      -- A previous test run may have set
      -- bankInfo.mahnungConfig to the old
      -- pre-2023 values (0/2.5/5), which the
      -- test then asserts against as 'wrong'.
      \"bankInfo\"=NULL
  WHERE id='$COMPANY_ID';
" >/dev/null
ok "company seeded"

# 4b. Tier 256: trigger the default-account seed
#     so 4400 (Wareneinsatz) + 4980 (Adobe)
#     exist for the Tier 26 Sachkonten
#     auto-inference spec. The endpoint is
#     idempotent (skips existing accounts).
note "seeding default SKR03 accounts (4400, 4980) ..."
curl -sS "$API/api/v1/accounting/accounts/seed?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" >/dev/null
ok "default accounts seeded"

# 5. Tier 250: seed the stable test fixtures
#    that 30+ Playwright specs depend on. Each
#    spec hardcodes the UUIDs in its beforeAll
#    and assumes the row exists in the dev/ci DB.
#    The seed creates them idempotently (ON
#    CONFLICT DO NOTHING) with the real
#    companyId (not the dryrun one).
#
#    Why: 30+ specs had FK violations on fresh DB
#    because the companyId was hardcoded to a
#    dryrun-only UUID. Tier 250 swapped the
#    companyId to read from the auth cache, but
#    the customer/invoice UUIDs are still
#    hardcoded. Seeding them here with the real
#    companyId makes the specs pass against
#    any DB.
#
#    Stable IDs (don't change without updating
#    the specs):
#      b3f7b274-...  = BWA Test Kunde (the main
#                      customer most specs hit)
#      11deeb35-...  = Test invoice (paid, for
#                      XRechnung / PDF specs)
#      11111111-2222-... = BWA Test Kunde duplicate
#                           (merge spec only)
#      11111111-aaaa-... = Test invoice OK 1
#      11111111-aaaa-...-02 = Test invoice OK 2
#      11111111-bbbb-... = Test customer OK
#      11111111-bbbb-...-02 = Test customer no-email
#      11111111-cccc-... = Various test customers
#                           (credit-limit, overdue)
note "seeding test fixtures (BWA Test Kunde + invoices) ..."
psql_test <<SQL
-- Main customer: BWA Test Kunde GmbH
-- creditLimit = NULL because the credit-limit-warning
-- spec's "empty list when no customers have a limit"
-- assertion needs to run with no other customers
-- holding a limit (the test's setupFixtures creates
-- the 4 customers it cares about).
INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit", "vatId")
VALUES ('b3f7b274-7696-44b8-9345-8bfd460b3e47', '$COMPANY_ID', 'business', 'BWA Test Kunde GmbH',
  '{"street":"Hauptstr 1","city":"Berlin","postalCode":"10115","country":"DE"}'::jsonb,
  '{"email":"bwa@example.com","name":"BWA Test"}'::jsonb, 30, ARRAY['VIP','B2B','Hardware']::text[],
  NOW(), NOW(), NULL, 'DE123456789')
ON CONFLICT (id) DO UPDATE SET "creditLimit" = NULL, tags = ARRAY['VIP','B2B','Hardware']::text[], name = 'BWA Test Kunde GmbH', "updatedAt" = NOW(), "vatId" = 'DE123456789';

-- BWA Test Kunde duplicate (for merge spec)
INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt")
VALUES ('11111111-2222-3333-4444-555555555555', '$COMPANY_ID', 'business', 'BWA Test Kunde GmbH (duplicate)',
  '{"street":"Hauptstr 1","city":"Berlin","postalCode":"10115","country":"DE"}'::jsonb,
  '{"email":"duplicate@example.com"}'::jsonb, 30, ARRAY['Hardware','Late-payer']::text[],
  NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW();

-- Test customers (credit-limit / mahnung / etc.)
-- All customers get creditLimit=NULL so the credit-limit-warning
-- spec's "empty list when no customers have a limit" assertion
-- can run after the spec's own cleanupFixtures() wipes the
-- 4 specific test customers (CUST_OK/WARNING/OVER/NO_LIMIT).
-- Without NULL defaults here, my 8 extra customers would
-- leak into the empty-list assertion and fail it.
-- ON CONFLICT DO UPDATE: critical — without this, re-running
-- the seed on a DB that already has these rows with
-- creditLimit=5000 leaves the old (wrong) value. The
-- spec's empty-list assertion then fails.
-- Müller GmbH K-00001 (Tier 28 search spec needs this
-- to assert the "muller" unaccented search hits the
-- Müller row). ON CONFLICT DO UPDATE so re-runs of
-- the seed restore the name + customerNumber.
-- Note: customerNumber 'K-00001' is taken by the
-- Tier 44 test customer (pre-existing), so we use
-- 'K-MULLER' to avoid a unique constraint collision.
INSERT INTO "Customer" (id, "companyId", type, name, "customerNumber", address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit")
VALUES ('b9799545-956b-40db-8fcd-769b2d429aa9', '$COMPANY_ID', 'business', 'Müller GmbH', 'K-MULLER', '{"street":"Hauptstr 1","city":"Berlin","postalCode":"10115","country":"DE"}'::jsonb, '{"email":"mueller@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "customerNumber" = EXCLUDED."customerNumber", "updatedAt" = NOW();

-- ANS Prüfungs GmbH (Tier 95 global search needs this
-- for the "no hits for ANS" negative case to have a
-- baseline; the test asserts the search returns 0 hits
-- when the seed is clean, so we add a baseline row
-- that gets cleaned by the test's beforeAll).
INSERT INTO "Customer" (id, "companyId", type, name, "customerNumber", address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit")
VALUES ('c0c0c0c0-0000-0000-0000-000000000001', '$COMPANY_ID', 'business', 'ANS Prüfungs GmbH', 'ANS-001', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"ans@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "customerNumber" = EXCLUDED."customerNumber", "updatedAt" = NOW();

INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit")
VALUES
  ('11111111-cccc-dddd-eeee-000000000001', '$COMPANY_ID', 'business', 'OK Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"ok@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('11111111-cccc-dddd-eeee-000000000002', '$COMPANY_ID', 'business', 'Warning Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"warn@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('11111111-cccc-dddd-eeee-000000000003', '$COMPANY_ID', 'business', 'Over Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"over@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('11111111-cccc-dddd-eeee-000000000004', '$COMPANY_ID', 'business', 'NoLimit Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"nolimit@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('22222222-bbbb-cccc-dddd-000000000001', '$COMPANY_ID', 'business', 'Bulk OK Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"bulkok@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('22222222-bbbb-cccc-dddd-000000000002', '$COMPANY_ID', 'business', 'Bulk NoEmail Kunde', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":""}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('11111111-cccc-dddd-eeee-111111161007', '$COMPANY_ID', 'business', 'Cust 7', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"c7@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL),
  ('11111111-cccc-dddd-eeee-111111161019', '$COMPANY_ID', 'business', 'Cust 19', '{"street":"S1","city":"B","postalCode":"1","country":"DE"}'::jsonb, '{"email":"c19@example.com"}'::jsonb, 30, '{}'::text[], NOW(), NOW(), NULL)
ON CONFLICT (id) DO UPDATE SET "creditLimit" = NULL, "updatedAt" = NOW();

-- Test invoice (overdue, used by XRechnung / PDF signature /
-- Mahnung modal / etc.). Status 'sent' + dueDate in the past
-- triggers the manual-Mahnung button on the invoice detail
-- page (see src/app/dashboard/invoices/[id]/page.tsx ~1757
-- — "status === 'sent' || 'overdue' && dueDate < now").
-- Tier 164's fees-preview spec navigates to this invoice
-- and clicks "Mahnung senden" to open the modal.
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "issueDate", "dueDate", subtotal, "totalVat", total, status, "createdAt", "updatedAt")
VALUES ('11deeb35-7147-4bdc-86d9-a302b4f80f3e', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-TEST-001', '2026-06-01', NOW() - INTERVAL '30 days', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO UPDATE SET status = 'sent', "dueDate" = NOW() - INTERVAL '30 days', "updatedAt" = NOW();

-- Test invoices for bulk-send / mahnung specs
-- ON CONFLICT DO UPDATE: keeps status='sent' so the bulk-mahnung
-- spec's idempotency check sees the right state. If a previous
-- run marked the invoice 'paid', DO NOTHING would leave it.
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "issueDate", "dueDate", subtotal, "totalVat", total, status, "createdAt", "updatedAt")
VALUES
  ('11111111-aaaa-bbbb-cccc-000000000001', '$COMPANY_ID', '22222222-bbbb-cccc-dddd-000000000001', 'INV-BULK-001', '2026-06-01', '2026-07-01', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '20 days', NOW()),
  ('11111111-aaaa-bbbb-cccc-000000000002', '$COMPANY_ID', '22222222-bbbb-cccc-dddd-000000000001', 'INV-BULK-002', '2026-06-15', '2026-07-15', 200.00, 38.00, 238.00, 'sent', NOW() - INTERVAL '15 days', NOW()),
  ('11111111-aaaa-bbbb-cccc-000000000003', '$COMPANY_ID', '22222222-bbbb-cccc-dddd-000000000002', 'INV-BULK-003', '2026-06-01', '2026-07-01', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '20 days', NOW())
ON CONFLICT (id) DO UPDATE SET status = 'sent', "dueDate" = EXCLUDED."dueDate", "updatedAt" = NOW();

-- Portal-test customer (Tier 133 / Tier 30):
-- the /customer-portal/request-session endpoint
-- resolves the customer by contact email and then
-- returns their invoices. The frontend Playwright
-- spec uses 'tier133-customer@example.com' (or a
-- per-run unique variant) — we seed a matching
-- customer + an invoice for them so the portal page
-- has data to render.
INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit")
VALUES ('aabbccdd-1337-1337-1337-000000000001', '$COMPANY_ID', 'business', 'Tier 133 Portal Testkunde',
  '{"street":"Portalstr 1","city":"Berlin","postalCode":"10117","country":"DE"}'::jsonb,
  '{"email":"tier133-customer@example.com","name":"Tier 133 Test"}'::jsonb, 30, ARRAY['Portal']::text[],
  NOW(), NOW(), NULL)
ON CONFLICT (id) DO UPDATE SET "contact" = '{"email":"tier133-customer@example.com","name":"Tier 133 Test"}'::jsonb, "updatedAt" = NOW();

INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "sequencePrefix", "sequenceYear", "sequenceNumber", type, status, "issueDate", "dueDate", subtotal, "totalVat", total, currency, language, "createdAt", "updatedAt")
VALUES ('aabbccdd-1337-1337-1337-000000000010', '$COMPANY_ID', 'aabbccdd-1337-1337-1337-000000000001', 'PORTAL-001', 'PORTAL-', 2026, 1, 'INV', 'sent', '2026-06-01', NOW() + INTERVAL '30 days', 100.00, 19.00, 119.00, 'EUR', 'de-DE', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET status = 'sent', "updatedAt" = NOW();

-- A zero-amount voucher line for the datev-preview
-- "issues" spec (datev-preview.spec.ts). The DATEV
-- preview endpoint flags a "Betrag <= 0" warning; the
-- spec asserts the issues card is visible when any
-- issue is present. The seeded voucher is 'booked'
-- in the test date range so the preview picks it up.
--
-- Tier 347: this heredoc is <<SQL, NOT <<'SQL' -- it has
-- to expand $COMPANY_ID -- so the shell ALSO expands
-- backticks inside it as command substitution. Two SQL
-- comments here used backticks and ran on every seed:
-- one became a redirect from a file named "=" ("=: No
-- such file or directory") and the other tried to run a
-- non-ASCII character as a command. The irony is that
-- the second one WAS the comment warning about the
-- first. Never use backticks in a comment inside an
-- unquoted heredoc; plain double quotes are safe.
INSERT INTO "Voucher" (id, "companyId", "voucherNumber", date, description, status, "createdAt")
VALUES ('aabbccdd-1850-1850-1850-000000000001', '$COMPANY_ID', 'V-185-001', '2026-04-15', 'Tier 185 zero-amount Beleg', 'posted', NOW())
ON CONFLICT (id) DO UPDATE SET status = 'posted';

-- Tier 49 cost-center suggestion fixture:
-- The cost-center-suggest-prefix spec types "VER"
-- into the cc input and expects the datalist to
-- render >= 1 option (BK-HIST-001 has VERTRIEB
-- stamps on Sachkonto 4960). Seed a Voucher +
-- VoucherLine with costCenter='VERTRIEB' on 4960.
-- (We use a non-tier-prefixed name per the Tier 39
-- fixture-survival lesson — 'BK-HIST-001' is a
-- stable, dev-DB-cleanup-safe identifier.)
INSERT INTO "Voucher" (id, "companyId", "voucherNumber", date, description, status, "createdAt")
VALUES ('BK-HIST-001', '$COMPANY_ID', 'BK-HIST-001', '2026-01-15', 'Tier 49 VERTRIEB fixture', 'posted', NOW())
ON CONFLICT (id) DO UPDATE SET status = 'posted';

-- Tier 347: 4960 is NOT in seedDefaultAccounts() (which creates 1000,
-- 1200, 1400, 1600, 1800, 2000, 2200, 2800, 4200, 4300, 4400, 4980,
-- 6000, 8000), so create it here. Reference it by a subquery on
-- accountNumber rather than a literal id: the default accounts are
-- created through the API with backend-generated UUIDs, so ANY
-- hard-coded account id in this file is guaranteed wrong on a fresh DB.
-- That is what broke the previous version — it pointed at
-- 'd8833d31-...', an id that exists in no seed path, and the FK
-- violation was swallowed because psql_test had no ON_ERROR_STOP.
INSERT INTO "Account" (id, "companyId", "accountNumber", name, type, "createdAt")
VALUES ('aabbccdd-0049-0049-0049-acc0004960', '$COMPANY_ID', '4960', 'Werbekosten (test)', 'expense', NOW())
ON CONFLICT ("companyId", "accountNumber") DO NOTHING;

INSERT INTO "VoucherLine" (id, "voucherId", "accountId", description, debit, credit, "vatRate", "vatAmount", "sortOrder", "costCenter", "costObject")
VALUES
  ('BK-HIST-001-L1', 'BK-HIST-001', (SELECT id FROM "Account" WHERE "companyId" = '$COMPANY_ID' AND "accountNumber" = '4960'), 'Tier 49 VERTRIEB line 1', 0, 100, NULL, NULL, 0, 'VERTRIEB', NULL),
  ('BK-HIST-001-L2', 'BK-HIST-001', (SELECT id FROM "Account" WHERE "companyId" = '$COMPANY_ID' AND "accountNumber" = '4960'), 'Tier 49 VERTRIEB line 2', 100, 0, NULL, NULL, 1, 'VERTRIEB', NULL)
ON CONFLICT (id) DO UPDATE SET debit = EXCLUDED.debit, credit = EXCLUDED.credit, "accountId" = EXCLUDED."accountId", "costCenter" = 'VERTRIEB';

-- A Voucher whose line has konto = 8400 (Erlöse)
-- but no VAT-Schlüssel. The datev-preview endpoint
-- flags this as
--   "Erlöskonto 8400 ohne USt-Schlüssel in Buchung V-185-001"
-- The spec asserts the issues card renders when any
-- issue is present. The voucher is 'posted' (matches
-- the buildBuchungenFromDb filter) and the line has
-- the standard 2-line structure so each line has a
-- valid Gegenkonto.
-- Use the existing 1200 (Bank) account; create a
-- dedicated 8400 (revenue) account with a Tier-185
-- specific ID so the VoucherLine FK doesn't collide
-- with seed data that already has a 1200 row.
INSERT INTO "Account" (id, "companyId", "accountNumber", name, type, "createdAt")
VALUES ('aabbccdd-1850-1850-1850-acc0008400', '$COMPANY_ID', '8400', 'Erlöse 19% (test)', 'revenue', NOW())
ON CONFLICT ("companyId", "accountNumber") DO NOTHING;

INSERT INTO "VoucherLine" (id, "voucherId", "accountId", description, debit, credit, "vatRate", "vatAmount", "sortOrder", "costCenter", "costObject")
VALUES
  ('aabbccdd-1850-1850-1850-000000000010', 'aabbccdd-1850-1850-1850-000000000001', (SELECT id FROM "Account" WHERE "companyId" = '$COMPANY_ID' AND "accountNumber" = '1200'), 'Tier 185 Erloese ohne USt', 0, 119, NULL, NULL, 0, NULL, NULL),
  ('aabbccdd-1850-1850-1850-000000000011', 'aabbccdd-1850-1850-1850-000000000001', (SELECT id FROM "Account" WHERE "companyId" = '$COMPANY_ID' AND "accountNumber" = '8400'), 'Tier 185 Erloese ohne USt', 119, 0, NULL, NULL, 1, NULL, NULL)
ON CONFLICT (id) DO UPDATE SET debit = EXCLUDED.debit, credit = EXCLUDED.credit, "accountId" = EXCLUDED."accountId", "vatRate" = NULL;

-- An unknown (never-existing) invoice for 404 tests
-- (the spec asserts 400 / 404 on this id)
SQL
ok "test fixtures seeded (3 customers + 4 invoices)"

# 5b. Tier 256: seed a Product (Tier 32
#     bulk-mail test assumes at least one
#     product exists).
psql_test <<SQL
INSERT INTO "Product" (id, "companyId", sku, name, "basePrice", "createdAt", "updatedAt")
VALUES ('99999999-0000-0000-0000-000000000001', '$COMPANY_ID', 'TEST-SKU-001', 'Test Product', 19.00, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW();
SQL
ok "test product seeded"

# 5c. Tier 144: seed 13+ EmailSend rows for
#     BWA Test Kunde. The customer-email-history
#     spec asserts rows.length > 0 and total > 0
#     against the /api/v1/customers/:id/emails
#     endpoint. Without these rows the spec fails
#     with "rows=0" or "total=0" on a freshly
#     bootstrapped CI DB. The dev DB has them from
#     earlier tier flows (Tier 141/142), but the
#     CI DB is rebuilt from schema.prisma every
#     run, so we have to seed them here.
#     Use stable non-tier-prefixed uuids so the
#     Tier 39 LIKE 'Tier<N>%' cleanup pattern
#     (if any future tier adds one) doesn't drop
#     them by accident.
psql_test <<SQL
INSERT INTO "EmailSend" (id, "companyId", "invoiceId", "templateType", "recipientEmail", "recipientName", "subject", "bodyPreview", "status", "sentAt", "createdById", "createdAt")
VALUES
  ('11111111-aaaa-0000-0000-000000000001', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-001', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '40 days', '$USER_ID', NOW() - INTERVAL '40 days'),
  ('11111111-aaaa-0000-0000-000000000002', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-002', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '30 days', '$USER_ID', NOW() - INTERVAL '30 days'),
  ('11111111-aaaa-0000-0000-000000000003', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'mahnung', 'bwa@example.com', 'BWA Test', 'Mahnung INV-2026-001', 'Sehr geehrte Damen und Herren, wir möchten Sie höflich an die überfällige Rechnung erinnern...', 'opened', NOW() - INTERVAL '25 days', '$USER_ID', NOW() - INTERVAL '25 days'),
  ('11111111-aaaa-0000-0000-000000000004', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-003', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '20 days', '$USER_ID', NOW() - INTERVAL '20 days'),
  ('11111111-aaaa-0000-0000-000000000005', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'kontoauszug', 'bwa@example.com', 'BWA Test', 'Kontoauszug Q1', 'Sehr geehrte Damen und Herren, anbei erhalten Sie den Kontoauszug...', 'opened', NOW() - INTERVAL '15 days', '$USER_ID', NOW() - INTERVAL '15 days'),
  ('11111111-aaaa-0000-0000-000000000006', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-004', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'delivered', NOW() - INTERVAL '10 days', '$USER_ID', NOW() - INTERVAL '10 days'),
  ('11111111-aaaa-0000-0000-000000000007', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'mahnung', 'bwa@example.com', 'BWA Test', '2. Mahnung INV-2026-001', 'Sehr geehrte Damen und Herren, dies ist die zweite Mahnung...', 'bounced', NOW() - INTERVAL '8 days', '$USER_ID', NOW() - INTERVAL '8 days'),
  ('11111111-aaaa-0000-0000-000000000008', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-005', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '6 days', '$USER_ID', NOW() - INTERVAL '6 days'),
  ('11111111-aaaa-0000-0000-000000000009', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'bulk_send', 'bwa@example.com', 'BWA Test', 'Sammelversand Batch-001', 'Sehr geehrte Damen und Herren, anbei erhalten Sie mehrere Dokumente...', 'opened', NOW() - INTERVAL '5 days', '$USER_ID', NOW() - INTERVAL '5 days'),
  ('11111111-aaaa-0000-0000-000000000010', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-006', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '4 days', '$USER_ID', NOW() - INTERVAL '4 days'),
  ('11111111-aaaa-0000-0000-000000000011', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-007', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '3 days', '$USER_ID', NOW() - INTERVAL '3 days'),
  ('11111111-aaaa-0000-0000-000000000012', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-008', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'delivered', NOW() - INTERVAL '2 days', '$USER_ID', NOW() - INTERVAL '2 days'),
  ('11111111-aaaa-0000-0000-000000000013', '$COMPANY_ID', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', 'invoice', 'bwa@example.com', 'BWA Test', 'Rechnung INV-2026-009', 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung...', 'opened', NOW() - INTERVAL '1 day', '$USER_ID', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, "sentAt" = EXCLUDED."sentAt";
SQL
ok "test email-send history seeded (13 rows for BWA Test Kunde)"

# 5d. Tier 135: seed AuditLog rows under 3
#     distinct action prefixes (invoice.,
#     customer., payment.) so the audit-filter
#     action chips render and the OR-semantics
#     test can flip two chips. The dev DB has
#     them from the e2e runs, but the CI DB is
#     fresh every run, so the chip list would
#     otherwise be empty (stats.byAction = []).
#     We seed 5+5+3 rows so the chips have
#     non-trivial counts and the OR test's
#     total1 / total2 assertions have something
#     to compare.
psql_test <<SQL
INSERT INTO "AuditLog" (id, "companyId", "userId", action, "entityType", "entityId", "createdAt")
VALUES
  ('22222222-bbbb-0000-0000-000000000001', '$COMPANY_ID', '$USER_ID', 'invoice.created', 'Invoice', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', NOW() - INTERVAL '40 days'),
  ('22222222-bbbb-0000-0000-000000000002', '$COMPANY_ID', '$USER_ID', 'invoice.updated', 'Invoice', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', NOW() - INTERVAL '35 days'),
  ('22222222-bbbb-0000-0000-000000000003', '$COMPANY_ID', '$USER_ID', 'invoice.sent', 'Invoice', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', NOW() - INTERVAL '30 days'),
  ('22222222-bbbb-0000-0000-000000000004', '$COMPANY_ID', '$USER_ID', 'invoice.paid', 'Invoice', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', NOW() - INTERVAL '25 days'),
  ('22222222-bbbb-0000-0000-000000000005', '$COMPANY_ID', '$USER_ID', 'invoice.created', 'Invoice', '11deeb35-7147-4bdc-86d9-a302b4f80f3e', NOW() - INTERVAL '20 days'),
  ('22222222-bbbb-0000-0000-000000000006', '$COMPANY_ID', '$USER_ID', 'customer.created', 'Customer', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', NOW() - INTERVAL '40 days'),
  ('22222222-bbbb-0000-0000-000000000007', '$COMPANY_ID', '$USER_ID', 'customer.updated', 'Customer', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', NOW() - INTERVAL '30 days'),
  ('22222222-bbbb-0000-0000-000000000008', '$COMPANY_ID', '$USER_ID', 'customer.updated', 'Customer', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', NOW() - INTERVAL '20 days'),
  ('22222222-bbbb-0000-0000-000000000009', '$COMPANY_ID', '$USER_ID', 'customer.merged', 'Customer', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', NOW() - INTERVAL '10 days'),
  ('22222222-bbbb-0000-0000-000000000010', '$COMPANY_ID', '$USER_ID', 'customer.updated', 'Customer', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', NOW() - INTERVAL '5 days'),
  ('22222222-bbbb-0000-0000-000000000011', '$COMPANY_ID', '$USER_ID', 'payment.received', 'Payment', '33333333-0000-0000-0000-000000000001', NOW() - INTERVAL '15 days'),
  ('22222222-bbbb-0000-0000-000000000012', '$COMPANY_ID', '$USER_ID', 'payment.received', 'Payment', '33333333-0000-0000-0000-000000000002', NOW() - INTERVAL '8 days'),
  ('22222222-bbbb-0000-0000-000000000013', '$COMPANY_ID', '$USER_ID', 'payment.allocated', 'Payment', '33333333-0000-0000-0000-000000000003', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;
SQL
ok "test audit-log seeded (5 invoice. + 5 customer. + 3 payment. rows)"

# 5e. Tier 147: seed a RecurringInvoice
#     template named "Tier 136 Wartungsvertrag"
#     (the recurring-generated-invoices spec
#     locates the card via
#     `[data-recurring-name="Tier 136 Wartungsvertrag"]`
#     and asserts that the generated-invoices
#     modal shows >= 1 row). Without this
#     template the spec fails with
#     "card not found" before the modal can
#     even open.
psql_test <<SQL
INSERT INTO "RecurringInvoice" (id, "companyId", "customerId", name, interval, "intervalCount", "dayOfMonth", "startDate", "nextRunAt", "lastRunAt", currency, language, "invoiceStatus", "isActive", "createdAt", "updatedAt")
VALUES ('33333333-cccc-0000-0000-000000000001', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'Tier 136 Wartungsvertrag', 'monthly', 1, 1, NOW() - INTERVAL '6 months', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 month', 'EUR', 'de-DE', 'sent', true, NOW() - INTERVAL '6 months', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "isActive" = true, "updatedAt" = NOW();

INSERT INTO "RecurringInvoiceItem" (id, "recurringInvoiceId", description, quantity, "unitPrice", "vatRate", position)
VALUES ('33333333-cccc-0000-0000-000000000010', '33333333-cccc-0000-0000-000000000001', 'Wartung Standard', 1, 119.00, 0.19, 0)
ON CONFLICT (id) DO UPDATE SET "unitPrice" = EXCLUDED."unitPrice";

-- Two generated invoice runs for the modal's
-- table to render >= 1 row (the spec asserts
-- rows.length > 0).
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "issueDate", "dueDate", subtotal, "totalVat", total, status, "createdAt", "updatedAt")
VALUES
  ('44444444-dddd-0000-0000-000000000001', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-100', NOW() - INTERVAL '1 month', NOW(), 119.00, 22.61, 141.61, 'sent', NOW() - INTERVAL '1 month', NOW() - INTERVAL '1 month'),
  ('44444444-dddd-0000-0000-000000000002', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-101', NOW() - INTERVAL '2 month', NOW(), 119.00, 22.61, 141.61, 'paid', NOW() - INTERVAL '2 month', NOW() - INTERVAL '2 month')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;
SQL
ok "test recurring-invoice seeded (1 template + 2 generated invoices)"

# 5f. Tier 146: seed 4 open invoices for
#     BWA Test Kunde at €119 each. The
#     customer-payment-allocation spec
#     resets Payment rows in beforeEach but
#     expects the 4 invoices to exist (it
#     asserts "remaining" values are based
#     on the invoice count). Without these
#     invoices the spec fails on
#     "no invoices for customer" before
#     the modal can render.
psql_test <<SQL
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "issueDate", "dueDate", subtotal, "totalVat", total, status, "createdAt", "updatedAt")
VALUES
  ('55555555-eeee-0000-0000-000000000001', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-203', NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
  ('55555555-eeee-0000-0000-000000000002', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-204', NOW() - INTERVAL '8 days', NOW() + INTERVAL '22 days', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'),
  ('55555555-eeee-0000-0000-000000000003', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-205', NOW() - INTERVAL '6 days', NOW() + INTERVAL '24 days', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '6 days', NOW() - INTERVAL '6 days'),
  ('55555555-eeee-0000-0000-000000000004', '$COMPANY_ID', 'b3f7b274-7696-44b8-9345-8bfd460b3e47', 'INV-2026-206', NOW() - INTERVAL '4 days', NOW() + INTERVAL '26 days', 100.00, 19.00, 119.00, 'sent', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO UPDATE SET status = 'sent';
SQL
ok "test payment-allocation invoices seeded (4 open invoices for BWA Test Kunde)"

# 5g. Tier 347: the "Tier 50 fixture" customer.
#     frontend/e2e/customer-detail-tabs-tier238.spec.ts and
#     customer-detail-invoices-chip-tier243.spec.ts both hard-code
#     the customer UUID f84ebd20-4513-48e4-b331-87ba19477ae3 and
#     describe it in their comments as "created by Tier 50 e2e, has
#     1 invoice + 1 payment". It was never in any seed script — a
#     `grep -r f84ebd20` matched only those two spec files. It was
#     presumably a row in one developer's local dev DB. In CI the
#     customer never existed, so the detail page rendered nothing,
#     every dependent locator missed, and ~10 tests silently
#     `test.skip`-ed on "not present" from Tier 243 until now:
#     permanent zero coverage that CI reported as green.
#
#     Seeding it here (rather than from the specs' own beforeAll)
#     is deliberate: direct SQL sidesteps the Tier 174 P2002
#     invoice-sequence race that those specs' comments cite as the
#     reason they took the hard-coded shortcut in the first place.
#
#     The rows must satisfy, exactly:
#       tier238 - `tab-payments-count` reads "1"   -> exactly 1 payment
#               - payment row text contains "bank_transfer"
#                 and "e2e-50 test"                -> method + reference
#       tier243 - chip group renders               -> >= 1 invoice
#                 (page.tsx: `invoices.length > 0`)
#               - paid chip count is 1             -> exactly 1 paid invoice
psql_test <<SQL
INSERT INTO "Customer" (id, "companyId", type, name, "customerNumber", address, contact, "paymentTerms", tags, "createdAt", "updatedAt")
VALUES ('f84ebd20-4513-48e4-b331-87ba19477ae3', '$COMPANY_ID', 'business', 'Tier 50 Fixture Kunde GmbH', 'K-TIER50', '{"street":"Fixturestr 50","city":"Berlin","postalCode":"10115","country":"DE"}'::jsonb, '{"email":"tier50@example.com"}'::jsonb, 30, '{}'::text[], NOW() - INTERVAL '90 days', NOW())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW();

INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "issueDate", "dueDate", subtotal, "totalVat", total, status, "createdAt", "updatedAt")
VALUES ('f84ebd20-0001-0000-0000-000000000001', '$COMPANY_ID', 'f84ebd20-4513-48e4-b331-87ba19477ae3', 'INV-2026-006343', NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days', 100.00, 19.00, 119.00, 'paid', NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO UPDATE SET status = 'paid', "updatedAt" = NOW();

-- Exactly ONE payment: tier238 asserts the count badge reads "1".
-- paymentMethod is the raw backend enum value 'bank_transfer'
-- (English), NOT the German "Überweisung" — the spec asserts on the
-- stored value.
INSERT INTO "Payment" (id, "invoiceId", amount, currency, "paymentDate", "paymentMethod", reference, "createdAt")
VALUES ('f84ebd20-0002-0000-0000-000000000001', 'f84ebd20-0001-0000-0000-000000000001', 119.00, 'EUR', NOW() - INTERVAL '30 days', 'bank_transfer', 'e2e-50 test', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO UPDATE SET "paymentMethod" = 'bank_transfer', reference = 'e2e-50 test';
SQL
ok "Tier 50 fixture customer seeded (f84ebd20 + 1 paid invoice + 1 payment)"

# 5g. Tier 194 cashbook close: REMOVED in Tier 347.
#     This block inserted into a table named
#     "CashBookClose", which does not exist —
#     the model is `CashBookDailyClose` and has a
#     completely different column set
#     (businessDate / anfangsbestand / einnahmenSum
#     / endbestand, not periodStart / totalIn /
#     hash). The statement therefore errored on
#     every seed run since it was written, and
#     because psql_test lacked ON_ERROR_STOP the
#     failure was swallowed and the `ok` line still
#     printed. Nothing consumed the row either:
#     `66666666-ffff-...` was referenced nowhere
#     else in the repo, and
#     `cashbook-signature-tier194.spec.ts` closes
#     its own days through the API. Dead code —
#     deleted rather than repaired.

# 6. Write the auth cache file that the e2e
#    tests + Playwright spec rely on.
#    /tmp/cashbook-e2e-auth.env is the file
#    _lib.sh login() reads on subsequent calls.
#    Step 5 wrote it once; we overwrite with the
#    real IDs after the fixtures are seeded so
#    the cache is the source of truth.
mkdir -p /tmp
cat > /tmp/cashbook-e2e-auth.env <<EOF
USER_ID=$USER_ID
COMPANY_ID=$COMPANY_ID
EOF
ok "auth cache written to /tmp/cashbook-e2e-auth.env"
