#!/usr/bin/env bash
# Tier 99 (Polish #3) — production deploy
# readiness smoke test.
#
# Verifies the docker-compose.prod.yml
# is syntactically valid + the required
# env vars (POSTGRES_PASSWORD, JWT_SECRET)
# are properly required + the canonical
# deploy docs (DEPLOY.md, RUNBOOK.md,
# backup.sh) exist.
#
# This test does NOT spin up the prod
# stack — that requires real env vars
# + is environment-specific. The
# `docker compose config --quiet` is a
# fast lint that catches most regressions
# (missing volumes, bad env interpolation,
# invalid build context, etc.).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

note "=== 1. docker-compose.prod.yml validates ==="
cd "$REPO_ROOT"
# Pass dummy values for the required
# env vars so `config` doesn't bail
# on the interpolation. The `--quiet`
# flag only prints errors, so on
# success we get no output.
POSTGRES_PASSWORD=lint-test \
  JWT_SECRET=lint-test \
  docker compose -f docker-compose.prod.yml config --quiet
RC=$?
if [[ $RC -eq 0 ]]; then
  pass "docker-compose.prod.yml validates"
else
  fail "docker-compose.prod.yml has syntax / interpolation errors (exit=$RC)"
fi

note "=== 2. docker-compose.prod.yml has 3 services ==="
SERVICES=$(POSTGRES_PASSWORD=lint-test \
  JWT_SECRET=lint-test \
  docker compose -f docker-compose.prod.yml config --services 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
assert_eq "services list" "$SERVICES" "backend frontend postgres"

note "=== 3. Required env vars are declared as required ==="
for var in POSTGRES_PASSWORD JWT_SECRET; do
  if grep -qE "\\\${${var}:\\?.*required" docker-compose.prod.yml; then
    pass "${var} is required (compose :-? ... required syntax)"
  else
    fail "${var} is not marked as required"
  fi
done

note "=== 4. DEPLOY.md exists + has the production section ==="
DEPLOY="$REPO_ROOT/DEPLOY.md"
if [[ -f "$DEPLOY" ]]; then
  pass "DEPLOY.md exists"
  # Should mention docker compose + tier 11
  HAS_COMPOSE=$(grep -c "docker compose" "$DEPLOY" || echo 0)
  HAS_PROD=$(grep -c "production" "$DEPLOY" || echo 0)
  test "$HAS_COMPOSE" -gt 0 && pass "DEPLOY.md mentions docker compose" || fail "DEPLOY.md missing docker compose"
  test "$HAS_PROD" -gt 0 && pass "DEPLOY.md mentions production" || fail "DEPLOY.md missing production"
else
  fail "DEPLOY.md missing"
fi

note "=== 5. RUNBOOK.md exists (operational docs) ==="
RUNBOOK="$REPO_ROOT/RUNBOOK.md"
if [[ -f "$RUNBOOK" ]]; then
  pass "RUNBOOK.md exists ($(wc -l < "$RUNBOOK") lines)"
else
  fail "RUNBOOK.md missing"
fi

note "=== 6. backup.sh + restore.sh exist (data lifecycle) ==="
for f in scripts/backup.sh scripts/restore.sh; do
  if [[ -f "$REPO_ROOT/$f" ]]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

note "=== 7. backup.sh is executable ==="
if [[ -x "$REPO_ROOT/scripts/backup.sh" ]]; then
  pass "scripts/backup.sh is executable"
else
  fail "scripts/backup.sh not executable (run: chmod +x scripts/backup.sh)"
fi

note "=== 8. Backend Dockerfile present (tier 11) ==="
for f in backend/Dockerfile frontend/Dockerfile; do
  if [[ -f "$REPO_ROOT/$f" ]]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

note "=== 9. .env.example / .env.production docs the required vars ==="
# We don't ship a real .env in the repo
# (secrets), but the DEPLOY.md should
# list the env vars the operator must
# set. This is the soft check.
for var in POSTGRES_PASSWORD JWT_SECRET NEXT_PUBLIC_API_URL; do
  if grep -q "$var" "$DEPLOY" 2>/dev/null; then
    pass "DEPLOY.md documents $var"
  else
    fail "DEPLOY.md does not document $var"
  fi
done

summary
