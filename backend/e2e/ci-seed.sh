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
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" "$@"
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
INSERT INTO "Customer" (id, "companyId", type, name, address, contact, "paymentTerms", tags, "createdAt", "updatedAt", "creditLimit")
VALUES ('b3f7b274-7696-44b8-9345-8bfd460b3e47', '$COMPANY_ID', 'business', 'BWA Test Kunde GmbH',
  '{"street":"Hauptstr 1","city":"Berlin","postalCode":"10115","country":"DE"}'::jsonb,
  '{"email":"bwa@example.com","name":"BWA Test"}'::jsonb, 30, ARRAY['BWA','Hardware']::text[],
  NOW(), NOW(), NULL)
ON CONFLICT (id) DO UPDATE SET "creditLimit" = NULL, "updatedAt" = NOW();

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

-- An unknown (never-existing) invoice for 404 tests
-- (the spec asserts 400 / 404 on this id)
SQL
ok "test fixtures seeded (3 customers + 4 invoices)"

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
