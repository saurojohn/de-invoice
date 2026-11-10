#!/bin/bash
# Tier 828 — which code the server runs
#
# „Systembetrieb" said „Version 0.0.0" (the image has no package version) or
# nothing: after an update or a rollback nothing showed which commit was
# running. infra/prod/build.sh builds the images with GIT_COMMIT and
# BUILD_TIME; the backend reports them to the operator (GET /health/summary),
# the frontend carries its own commit and the page warns when the two differ.
# rollback.sh rebuilt the backend only — the pages stayed those of the newer
# code; it builds both now.
#
# Rehearsed on the production images (backend of one commit, pages of
# another): „Code <commit>, gebaut <date>" and the warning to rebuild both.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login # the seed admin: the operator
ROOT="$SCRIPT_DIR/../.."
TAG="e2e-526-$(date +%s%N | cut -c1-13)"

note "=== 1. GET /health/summary ==="
S=$(curl -sS "$API/api/v1/health/summary" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "the operator gets commit and build time (null on a server built by hand)" \
  "$(echo "$S" | python3 -c "import sys,json;d=json.load(sys.stdin);print('commit' in d, 'builtAt' in d)")" "True True"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier828-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
assert_eq "another company's admin does not" \
  "$(curl -sS "$API/api/v1/health/summary" -H "x-user-id: $U" -H "x-company-id: $C" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'] in ('ok','degraded','down'), 'commit' in d)")" "True False"
assert_eq "…nor the public /health" "$(curl -sS "$API/api/v1/health" | python3 -c "import sys,json;print('commit' in json.load(sys.stdin))")" "False"

note "=== 2. appVersion() ==="
P=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
import { appVersion } from './src/common/app-version'
const r = (c: string, b: string) => { process.env.APP_COMMIT = c; process.env.APP_BUILT_AT = b; const v = appVersion(); return (v.commit ?? 'null') + '|' + (v.builtAt ?? 'null') }
console.log([r('3815486A6DB6', '2026-11-10T18:24:27Z'), r('', ''), r('x; rm -rf /', 'gestern')].join(' '))
" 2>&1 | tail -1)
assert_eq "a commit lower-cased, the time as ISO; empty or not a commit / a time: null" "$P" \
  "3815486a6db6|2026-11-10T18:24:27.000Z null|null null|null"

note "=== 3. the build ==="
grep -q 'ARG GIT_COMMIT=""' "$ROOT/backend/Dockerfile" && grep -q 'APP_COMMIT=$GIT_COMMIT' "$ROOT/backend/Dockerfile" \
  && pass "the backend image takes the commit and the build time" || fail "backend/Dockerfile: no GIT_COMMIT"
grep -q 'ARG NEXT_PUBLIC_GIT_COMMIT=""' "$ROOT/frontend/Dockerfile" && pass "the pages take their commit" || fail "frontend/Dockerfile: no NEXT_PUBLIC_GIT_COMMIT"
grep -q 'GIT_COMMIT: ${GIT_COMMIT:-}' "$ROOT/infra/prod/docker-compose.yml" && grep -q 'NEXT_PUBLIC_GIT_COMMIT: ${GIT_COMMIT:-}' "$ROOT/infra/prod/docker-compose.yml" \
  && pass "compose hands them to both builds" || fail "compose: no GIT_COMMIT build args"
B="$ROOT/infra/prod/build.sh"
bash -n "$B" && grep -q 'git rev-parse --short=12 HEAD' "$B" && grep -q 'export GIT_COMMIT BUILD_TIME' "$B" \
  && pass "infra/prod/build.sh builds with the checked-out commit" || fail "build.sh missing or incomplete"
grep -q 'bash infra/prod/build.sh' "$ROOT/infra/prod/HETZNER-DEPLOY.sh" && pass "the deploy builds through it" || fail "HETZNER-DEPLOY.sh does not use build.sh"
grep -q 'build.sh" backend frontend' "$ROOT/infra/prod/rollback.sh" && ! grep -qE '^docker compose build backend$' "$ROOT/infra/prod/rollback.sh" \
  && pass "a rollback rebuilds backend and frontend (was the backend only)" || fail "rollback.sh rebuilds the backend only"
assert_eq "the runbooks build through build.sh" \
  "$(grep -hE '^(sudo )?docker compose -f infra/prod/docker-compose.yml build' "$ROOT/infra/prod/RUNBOOK.md" "$ROOT/infra/prod/README.md" "$ROOT/infra/prod/HETZNER-DEPLOY.md" | wc -l | tr -d ' ')" "0"
grep -q 'NEXT_PUBLIC_GIT_COMMIT' "$ROOT/frontend/src/app/dashboard/operator/page.tsx" \
  && pass "„Systembetrieb“ compares the pages' commit with the server's" || fail "the operator page shows no commit"
summary
