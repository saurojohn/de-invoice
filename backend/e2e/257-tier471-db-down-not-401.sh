#!/bin/bash
# Tier 471 — a database outage is no failed login
#
# Found in a local run of spec 193: two of eight parallel creates answered
# 401 "Authentifizierung fehlgeschlagen" — the auth guard caught Prisma's
# "Can't reach database server" as a failed authentication. The frontend
# clears the session on 401, so a database hiccup logged the user out, and as
# a 4xx it never reached ErrorEvent. Measured before: with the database
# stopped, GET /customers answered 401.
#
# Stops and starts the Postgres container, so it runs only in CI or against a
# throwaway container named in PG_CONTAINER — never the dev database.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
PGC="${PG_CONTAINER:-de-invoice-postgres}"
if [[ "${CI:-}" != "true" && "$PGC" == "de-invoice-postgres" ]]; then
  echo "SKIP: stops the database container — only in CI or with PG_CONTAINER set to a throwaway container"
  exit 77
fi
login
TAG="e2e-257-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier471-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
code() { curl -sS -o /dev/null -w "%{http_code}" --max-time 30 "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"; }
assert_eq "fixture: the request works" "$(code)" "200"

docker stop -t 5 "$PGC" >/dev/null
DOWN=$(code)
docker start "$PGC" >/dev/null
for _ in $(seq 1 30); do docker exec "$PGC" pg_isready -q -U de_invoice 2>/dev/null && break; sleep 1; done
assert_eq "database down: 503, not 401 (was 401 Authentifizierung fehlgeschlagen)" "$DOWN" "503"

UP=""; for _ in $(seq 1 20); do UP=$(code); [[ "$UP" == 200 ]] && break; sleep 1; done
assert_eq "database back: the same credentials work again" "$UP" "200"

summary
