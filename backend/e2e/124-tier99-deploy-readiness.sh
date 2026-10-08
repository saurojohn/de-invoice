#!/usr/bin/env bash
# Tier 99 (Polish #3) — production deploy
# readiness smoke test.
#
# Verifies that the production compose file is syntactically valid, that the
# variables it cannot run without are declared as required, and that the
# documents an operator starts from exist.
#
# Tier 584: there is ONE production path, infra/prod/. This spec used to lint
# the root `docker-compose.prod.yml` (host nginx, TRUST_PROXY 0, no
# FRONTEND_URL — never run) and ask for a root RUNBOOK.md written for it; both
# are gone, and the spec holds that they stay gone.
#
# This test does NOT spin up the stack — `docker compose config --quiet` is a
# fast lint that catches most regressions (missing volumes, bad env
# interpolation, invalid build context, etc.).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE="$REPO_ROOT/infra/prod/docker-compose.yml"
lint() { POSTGRES_PASSWORD=lint-test JWT_SECRET=lint-test FRONTEND_URL=https://lint-test.invalid docker compose -f "$COMPOSE" config "$@"; }

note "=== 1. infra/prod/docker-compose.yml validates ==="
cd "$REPO_ROOT"
if ! docker compose version >/dev/null 2>&1; then
  note "SKIP: docker compose is not available here"
else
  lint --quiet
  RC=$?
  if [[ $RC -eq 0 ]]; then
    pass "infra/prod/docker-compose.yml validates"
  else
    fail "infra/prod/docker-compose.yml has syntax / interpolation errors (exit=$RC)"
  fi

  note "=== 2. its services ==="
  SERVICES=$(lint --services 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
  assert_eq "services list" "$SERVICES" "backend backup caddy frontend postgres"
fi

note "=== 3. Required env vars are declared as required ==="
for var in POSTGRES_PASSWORD JWT_SECRET FRONTEND_URL; do
  if grep -qE "\\\${${var}:\\?.*required" "$COMPOSE"; then
    pass "${var} is required (compose :-? ... required syntax)"
  else
    fail "${var} is not marked as required"
  fi
done

note "=== 4. one production path, and DEPLOY.md points to it ==="
DEPLOY="$REPO_ROOT/DEPLOY.md"
assert_eq "the second path is gone: no root docker-compose.prod.yml, no root RUNBOOK.md" "$([[ -e "$REPO_ROOT/docker-compose.prod.yml" ]] && echo there || echo gone)/$([[ -e "$REPO_ROOT/RUNBOOK.md" ]] && echo there || echo gone)" "gone/gone"
if [[ -f "$DEPLOY" ]]; then
  pass "DEPLOY.md exists"
  assert_eq "…and sends the reader to infra/prod, not to a removed file" "$(grep -c 'infra/prod/README.md' "$DEPLOY" | awk '{print ($1>=1)}')/$(grep -c 'docker compose -f docker-compose.prod.yml' "$DEPLOY")" "1/0"
else
  fail "DEPLOY.md missing"
fi
assert_eq "no document outside docs/history tells anyone to use the removed compose file" "$(grep -rl 'docker compose -f docker-compose.prod.yml' "$REPO_ROOT"/*.md "$REPO_ROOT/infra" "$REPO_ROOT/scripts" 2>/dev/null | grep -v '/HANDOFF.md$' | wc -l | tr -d ' ')" "0"

note "=== 5. the operator's documents exist ==="
for f in README.md HETZNER-DEPLOY.md RUNBOOK.md SECURITY.md DR-TEST.md .env.example restore.sh; do
  [[ -f "$REPO_ROOT/infra/prod/$f" ]] && pass "infra/prod/$f exists" || fail "infra/prod/$f missing"
done
# Tier 584: every variable the compose file reads is explained in the example
# env file (nine were not — among them the app's SMTP settings and
# SYSTEM_ADMIN_EMAILS — so an operator could not know they exist).
MISSING=$(python3 - "$COMPOSE" "$REPO_ROOT/infra/prod/.env.example" <<'PY'
import re, sys
used = sorted(set(re.findall(r"\$\{([A-Z0-9_]+)", open(sys.argv[1]).read())))
have = set(re.findall(r"^#?\s*([A-Z0-9_]+)=", open(sys.argv[2]).read(), flags=re.M))
print(" ".join(v for v in used if v not in have))
PY
)
assert_eq "infra/prod/.env.example names every variable the compose file reads" "$MISSING" ""

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
# We don't ship a real .env in the repo (secrets); the example env file
# lists what the operator must set.
for var in POSTGRES_PASSWORD JWT_SECRET FRONTEND_URL; do
  if grep -q "^$var=" "$REPO_ROOT/infra/prod/.env.example" 2>/dev/null; then
    pass "infra/prod/.env.example documents $var"
  else
    fail "infra/prod/.env.example does not document $var"
  fi
done

note "=== 10. Frontend image gets NEXT_PUBLIC_API_URL at BUILD time (Tier 363) ==="
# `next build` inlines NEXT_PUBLIC_* into the bundles. Until Tier 363 the
# frontend Dockerfile had no ARG and both compose files passed the value only
# as runtime `environment:`, so a production image called
# http://localhost:3001 from every browser (48 client chunks in an image built
# from a clean checkout). The subdirectory build contexts also ignored the
# root .dockerignore, letting a developer's .env.local into the build.
FE_DOCKERFILE="$REPO_ROOT/frontend/Dockerfile"
grep -qE '^ARG NEXT_PUBLIC_API_URL' "$FE_DOCKERFILE" \
  && pass "frontend/Dockerfile declares ARG NEXT_PUBLIC_API_URL" \
  || fail "frontend/Dockerfile has no ARG NEXT_PUBLIC_API_URL (bundle falls back to http://localhost:3001)"
for f in infra/prod/docker-compose.yml; do
  FE_BLOCK=$(awk '/^  frontend:/{p=1; next} p && /^  [a-z]/{p=0} p' "$REPO_ROOT/$f")
  if echo "$FE_BLOCK" | grep -A4 -E '^\s+args:' | grep -q 'NEXT_PUBLIC_API_URL:'; then
    pass "$f passes NEXT_PUBLIC_API_URL as a frontend build arg"
  else
    fail "$f does not pass NEXT_PUBLIC_API_URL as a frontend build arg"
  fi
done
for ctx in frontend backend; do
  grep -qxE '\.env(\.\*)?' "$REPO_ROOT/$ctx/.dockerignore" 2>/dev/null \
    && pass "$ctx/.dockerignore excludes .env files" \
    || fail "$ctx/.dockerignore missing or does not exclude .env files"
done

note "=== 11. No hardcoded backend host in frontend/src (Tier 363) ==="
# The build arg alone was not enough: login, register, password reset, 2FA,
# user management, reminders, UStVA and more fetched a literal
# http://localhost:3001 (27 places), so a production deploy could not even log
# in. Every call now goes through API_BASE (src/lib/api.ts). Lines that read
# NEXT_PUBLIC_API_URL with a fallback are fine — the build arg replaces them.
HARDCODED=$(grep -rn 'localhost:3001' "$REPO_ROOT/frontend/src" 2>/dev/null \
  | grep -v 'NEXT_PUBLIC_API_URL' | grep -v '/src/lib/api.ts:' || true)
if [[ -z "$HARDCODED" ]]; then
  pass "frontend/src has no hardcoded localhost:3001 outside src/lib/api.ts"
else
  fail "hardcoded localhost:3001 in frontend/src (use API_BASE from @/lib/api):
$HARDCODED"
fi


note "=== 12. the first company is the one its owner registers (Tier 584) ==="
# HETZNER-DEPLOY.sh (and two guides) inserted a company row by hand. It had
# no user and was the OLDEST company — whose admins are the installation's
# operators. Measured: the first person to register then got 403 on
# /admin/backups, /storage/config and /admin/cron-health; nobody could
# operate the installation.
PRODDIR="$REPO_ROOT/infra/prod"
assert_eq "the deploy script and the guides insert no company or user by hand" "$(cat "$PRODDIR"/HETZNER-DEPLOY.sh "$PRODDIR"/*.md | grep -c 'INSERT INTO')" "0"
assert_eq "…and tell the operator to register the first account" "$(grep -c '/register' "$PRODDIR/HETZNER-DEPLOY.sh" "$PRODDIR/HETZNER-DEPLOY.md" "$PRODDIR/README.md" | awk -F: '{n += ($2 >= 1)} END {print n}')" "3"
assert_eq "no guide applies the schema with db push" "$(grep -l 'npx prisma db push' "$PRODDIR"/*.md "$PRODDIR"/*.sh 2>/dev/null | wc -l | tr -d ' ')" "0"

note "=== 13. ./start.sh and ./stop.sh on a developer machine (Tier 584) ==="
# start.sh ran `prisma db push --accept-data-loss` against the developer's
# database on every start and `kill -9`ed whatever listened on :3001 / :3000
# (and every `next dev` on the machine); stop.sh did the same.
START="$REPO_ROOT/start.sh"; STOP="$REPO_ROOT/stop.sh"
bash -n "$START" && bash -n "$STOP" && pass "start.sh and stop.sh parse" || fail "start.sh / stop.sh have a syntax error"
code() { grep -v '^[[:space:]]*#' "$1"; }
assert_eq "start.sh applies migrations and never pushes the schema" "$(code "$START" | grep -c 'npx prisma migrate deploy')/$(code "$START" | grep -c 'npx prisma db push')" "1/0"
assert_eq "neither script kills a port's listener or a process by name" "$(cat "$START" "$STOP" | grep -v '^[[:space:]]*#' | grep -cE 'lsof -ti:[^|]*\| *xargs|pgrep -f|pkill')" "0"
assert_eq "…they stop only processes started inside this checkout" "$(grep -c 'case "\$cwd" in "\$ROOT"|"\$ROOT"/\*)' "$START" "$STOP" | awk -F: '{n += ($2 >= 1)} END {print n}')" "2"
assert_eq "start.sh prints no login" "$(code "$START" | grep -ci 'Test1234\|passwor[dt]:')" "0"

summary
