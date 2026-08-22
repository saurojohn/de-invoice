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
psql_test() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" "$@"
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
      \"invoicePrefix\"='INV-'
  WHERE id='$COMPANY_ID';
" >/dev/null
ok "company seeded"

# 5. Write the auth cache file that the e2e
#    tests + Playwright spec rely on.
#    /tmp/cashbook-e2e-auth.env is the file
#    _lib.sh login() reads on subsequent calls.
mkdir -p /tmp
cat > /tmp/cashbook-e2e-auth.env <<EOF
USER_ID=$USER_ID
COMPANY_ID=$COMPANY_ID
EOF
ok "auth cache written to /tmp/cashbook-e2e-auth.env"
