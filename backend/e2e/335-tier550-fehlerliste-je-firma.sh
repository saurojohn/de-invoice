#!/bin/bash
# Tier 550 — "resolve all" is all of the company's, not all of everyone's
#
# The error list shows a company its own rows. Its three bulk actions did not
# stop there. Measured as the admin of a company registered a minute before:
# POST /system/errors/mute-all → {"count":209}, every open row of every
# company muted; resolve-all the same; POST /system/errors/prune deleted
# every company's resolved, muted and old rows. And the same error reported
# by two companies was one row, the first company's: the second never saw it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-335-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
tenant() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier550-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA CA < <(tenant a); read -r UB CB < <(tenant b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
EMPTY='{}'
post() { # A|B path [body] → body
  local u=$UA c=$CA; [[ "$1" == B ]] && { u=$UB; c=$CB; }
  curl -sS -m 30 -X POST "$API/api/v1/system/errors$2" -H "x-user-id: $u" -H "x-company-id: $c" -H "Content-Type: application/json" -d "${3:-$EMPTY}"
}
st() { q "select coalesce(string_agg(status, ',' order by message),'gone') from \"ErrorEvent\" where \"companyId\"='$1' and message like '$TAG%'"; }
report() { post "$1" "" "{\"message\":\"$TAG $2\",\"kind\":\"manual\"}" >/dev/null; }

report A one; report A two; report B one
assert_eq "the same error in two companies is a row in each (B's joined A's row)" "$(st "$CA")/$(st "$CB")" "open,open/open"
report A one
assert_eq "…and again in A: counted on A's row" "$(q "select occurrences from \"ErrorEvent\" where \"companyId\"='$CA' and message='$TAG one'")/$(q "select occurrences from \"ErrorEvent\" where \"companyId\"='$CB' and message='$TAG one'")" "2/1"

note "=== Tier 552: the rate list ==="
# GET /system/errors/top-rate grouped every company's rows: B read A's messages.
get() { local u=$UA c=$CA; [[ "$1" == B ]] && { u=$UB; c=$CB; }; curl -sS -m 30 "$API/api/v1/system/errors/top-rate?limit=50&windowMinutes=60" -H "x-user-id: $u" -H "x-company-id: $c"; }
RB=$(get B); RA=$(get A)
assert_eq "B's rate list has its one error, not A's two (was every company's)" "$(grep -o "$TAG [a-z]*" <<<"$RB" | sort -u | tr '\n' ',')" "$TAG one,"
assert_eq "…and counts it once (A's reports of the same error are A's)" "$(python3 -c "import json,sys;print([r['count'] for r in json.loads(sys.argv[1])['rows'] if r.get('message')=='$TAG one'])" "$RB")" "[1]"
assert_eq "A's has its two" "$(grep -o "$TAG [a-z]*" <<<"$RA" | sort -u | tr '\n' ',')" "$TAG one,$TAG two,"

note "=== mute-all ==="
assert_eq "B mutes all: its one row (was every company's)" "$(json_field "$(post B /mute-all)" count)" "1"
assert_eq "…B's is muted" "$(st "$CB")" "muted"
assert_eq "…A's rows are still open" "$(st "$CA")" "open,open"

note "=== resolve-all ==="
report B two
assert_eq "B resolves all: its one open row" "$(json_field "$(post B /resolve-all)" count)" "1"
assert_eq "…A's rows are still open" "$(st "$CA")" "open,open"
assert_eq "A resolves all: its two" "$(json_field "$(post A /resolve-all)" count)" "2"
assert_eq "…and they are resolved" "$(st "$CA")" "resolved,resolved"

note "=== prune ==="
assert_eq "B prunes: its two rows (one muted, one resolved)" "$(json_field "$(post B /prune)" deleted)" "2"
assert_eq "…B's are gone" "$(st "$CB")" "gone"
assert_eq "…A's resolved rows are still there (were deleted)" "$(st "$CA")" "resolved,resolved"
assert_eq "A prunes its own" "$(json_field "$(post A /prune)" deleted)" "2"

summary
