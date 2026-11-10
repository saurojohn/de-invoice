#!/bin/bash
# Tier 825 — the first day on the server, rehearsed on the production images
# (empty database, REGISTRATION=first-only, no SMTP):
#
#  1. Without a mail server the backend answered every mail as sent: a company
#     invitation „mailed: true", a Mahnung recorded as sent, a statement
#     likewise — the [NO-SMTP] log line was all. In production it refuses now
#     and says why; outside production the log stays (the suites read it).
#  2. The first registration of an empty installation makes its owner the
#     operator: between `docker compose up` and the owner's registration,
#     anyone who reached the address owned the server. With SETUP_TOKEN set
#     it needs the setup link /register?setup=<token>; once a company exists
#     it plays no part.
#  3. HETZNER-DEPLOY.sh built the images before .env existed — compose stopped
#     with „required variable POSTGRES_PASSWORD is missing" instead of the
#     script's own message; it did not check for a mail server; it wrote no
#     setup token. The smoke test advised certbot, which Caddy replaces.
#
# The empty database and production mode cannot be had on the test backend:
# scripts/probe-first-day.ts calls the rules directly; the rest is the files.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
TAG="e2e-523-$(date +%s%N | cut -c1-13)"

note "=== 1 + 2. the rules (scripts/probe-first-day.ts) ==="
P=$(cd "$SCRIPT_DIR/.." && npx ts-node -T scripts/probe-first-day.ts 2>&1 | tail -1)
pj() { echo "$P" | python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
assert_eq "production, no mail server: refused before and at the sending (was: answered as sent)" "$(pj 'd["production"]')" "assert:refused send:refused"
assert_eq "outside production: logged, as the suites expect" "$(pj 'd["development"]')" "assert:ok send:logged"
assert_eq "the setup link is asked for on an empty installation with SETUP_TOKEN only" \
  "$(pj 'd["requiredEmptyWithToken"], d["requiredEmptyWithout"], d["requiredOnceACompanyExists"]')" "True False False"
assert_eq "the token: equal (blanks trimmed) yes; one character off, shorter, no string, none set — no" \
  "$(pj 'd["matches"], d["matchesTrimmed"], d["wrong"], d["shorter"], d["notAString"], d["noTokenSet"]')" "True True False False False False"

note "=== 2. on the test backend (companies exist, no SETUP_TOKEN) ==="
CALL_JSON() { curl -sS -X "$1" "$API$2" -H "Content-Type: application/json" ${3:+-d "$3"}; }
assert_eq "GET /auth/registration says the link is not needed" \
  "$(CALL_JSON GET /api/v1/auth/registration | python3 -c 'import sys,json;print(json.load(sys.stdin)["setupRequired"])')" "False"
R=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier825-e2e\",\"companyName\":\"$TAG GmbH\",\"setupToken\":\"whatever\"}")
assert_eq "…and a token sent along changes nothing" "$R" "201"
grep -q "SETUP_TOKEN_MESSAGE" "$SCRIPT_DIR/../src/modules/auth/auth.controller.ts" \
  && grep -q "setupTokenRequired(source) && !setupTokenMatches(dto.setupToken)" "$SCRIPT_DIR/../src/modules/auth/auth.controller.ts" \
  && pass "POST /auth/register checks the link before anything else" || fail "the register route does not check the setup link"
grep -q 'search.get("setup")' "$ROOT/frontend/src/app/register/page.tsx" && grep -q 'registration-setup-required' "$ROOT/frontend/src/app/register/page.tsx" \
  && pass "the register page sends the link's token, and without it says how one comes in" || fail "the register page knows no setup link"

note "=== 3. the deploy ==="
D="$ROOT/infra/prod/HETZNER-DEPLOY.sh"
bash -n "$D" && pass "HETZNER-DEPLOY.sh parses" || fail "HETZNER-DEPLOY.sh: syntax"
ENV_STEP=$(grep -n 'log "Step 2/6 — configure .env"' "$D" | cut -d: -f1)
BUILD=$(grep -n 'docker compose -f infra/prod/docker-compose.yml build' "$D" | head -1 | cut -d: -f1)
assert_eq ".env is checked before the images are built" "$( [[ -n "$ENV_STEP" && -n "$BUILD" && "$ENV_STEP" -lt "$BUILD" ]] && echo yes || echo "env=$ENV_STEP build=$BUILD")" "yes"
grep -q 'for v in SMTP_HOST SMTP_USER SMTP_PASSWORD' "$D" && grep -q 'ALLOW_NO_SMTP' "$D" \
  && pass "it stops without SMTP host, user and password (ALLOW_NO_SMTP=1 overrides)" || fail "no SMTP check in the deploy"
grep -q 'SETUP_TOKEN=%s' "$D" && grep -q 'register?setup=$SETUP_TOKEN' "$D" \
  && pass "it writes a SETUP_TOKEN into .env and prints the setup link" || fail "no setup token in the deploy"
grep -q 'auth/registration' "$D" && grep -q 'health/deep' "$D" && grep -q 'de-invoice-backup running' "$D" \
  && pass "after the start it checks the database, the registration and the backup container" || fail "no first-day checks after the start"
grep -q 'SETUP_TOKEN: ${SETUP_TOKEN:-}' "$ROOT/infra/prod/docker-compose.yml" && grep -q '^# SETUP_TOKEN=' "$ROOT/infra/prod/.env.example" \
  && pass "compose hands SETUP_TOKEN to the backend, .env.example documents it" || fail "SETUP_TOKEN not wired through compose / .env.example"
! grep -q "Run 'certbot renew" "$ROOT/infra/prod/smoke-test.sh" && bash -n "$ROOT/infra/prod/smoke-test.sh" \
  && pass "the smoke test no longer sends the operator to certbot (Caddy renews)" || fail "smoke-test.sh still advises certbot"
summary
