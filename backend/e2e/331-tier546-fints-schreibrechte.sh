#!/bin/bash
# Tier 546 — the bank connection's writing routes need a writing role
#
# A sweep with a `viewer` of the company against every writing route found
# one 2xx: POST /fints/auto-match (201) — it confirms bank matches, i.e.
# records payments. The FinTS controller guarded five writing routes with
# `reports.read`, which every viewer has: starting a sync, answering its TAN,
# the auto-match, and — initiating a SEPA transfer and answering its TAN.
#
# Now: sync / TAN / auto-match need `accounting.create`, a transfer and its
# TAN `payment.write` (accountant and above). A viewer gets 403; an
# accountant is let through to the route's own checks.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-331-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
reg() { curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier546-e2e\",\"companyName\":\"$TAG $1\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null; }
read -r ADMIN C < <(reg admin)
read -r VIEWER _ < <(reg viewer)
read -r ACC _ < <(reg accountant)
q "INSERT INTO \"UserCompany\" (\"userId\", \"companyId\", role) VALUES ('$VIEWER', '$C', 'viewer'), ('$ACC', '$C', 'accountant')" >/dev/null
[[ -n "${C:-}" && -n "$VIEWER" && -n "$ACC" ]] && pass "fixture: a company with a viewer and an accountant" || { fail "register"; summary; exit 1; }
call() { # user method path body → status
  curl -s -o /tmp/t546.out -w '%{http_code}' -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$4"
}
ID0=00000000-0000-0000-0000-000000000000
ROUTES=(
  "/api/v1/fints/connections/$ID0/sync|{\"companyId\":\"$C\"}|a bank sync"
  "/api/v1/fints/sync-runs/$ID0/tan|{\"companyId\":\"$C\",\"tan\":\"123456\"}|a sync's TAN"
  "/api/v1/fints/auto-match|{\"companyId\":\"$C\"}|the auto-match"
  "/api/v1/fints/transfers|{\"companyId\":\"$C\",\"connectionId\":\"$ID0\",\"creditorName\":\"X\",\"creditorIban\":\"DE89370400440532013000\",\"amount\":1,\"purpose\":\"x\"}|a SEPA transfer"
  "/api/v1/fints/transfers/$ID0/tan|{\"companyId\":\"$C\",\"tan\":\"123456\"}|a transfer's TAN"
)

note "=== a viewer ==="
for r in "${ROUTES[@]}"; do IFS='|' read -r path body what <<< "$r"
  assert_eq "$what: 403 (was let through)" "$(call "$VIEWER" POST "$path" "$body")" "403"
done
assert_eq "a viewer still reads the connections" "$(call "$VIEWER" GET "/api/v1/fints/connections?companyId=$C" '')" "200"
assert_eq "…and the transfers" "$(call "$VIEWER" GET "/api/v1/fints/transfers?companyId=$C" '')" "200"

note "=== an accountant ==="
for r in "${ROUTES[@]}"; do IFS='|' read -r path body what <<< "$r"
  S=$(call "$ACC" POST "$path" "$body")
  assert_eq "$what: not a 403 — the route's own answer ($S)" "$([[ "$S" != 403 && "$S" != 5* ]] && echo ok || echo "$S $(head -c 120 /tmp/t546.out)")" "ok"
done
assert_eq "the auto-match itself answers the accountant with 201" "$(call "$ACC" POST "/api/v1/fints/auto-match" "{\"companyId\":\"$C\"}")" "201"
rm -f /tmp/t546.out

summary
