#!/bin/bash
# Tier 781 — who did it comes from the session, not from the headers
#
# The sweep of the routes a stranger reaches (Tier 780) found:
#   - main.ts started each request's audit context with the client's
#     x-user-id / x-company-id. HeaderAuthGuard overwrites them — but on a
#     public route it steps aside, and they stayed: an anonymous registration
#     sent with another company's ids wrote company.created and
#     usercompany.created into THAT company's trail, under THAT user.
#   - the internal notes of customers and invoices took their author from
#     x-user-id / x-user-email: the client's word, and absent with a session
#     (production sends none) — notes had no author, and a customer note could
#     be deleted by whoever named its author in the header, by a session never.
#     The admin was not recognised either (the role was passed as null).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-486-$(date +%s%N | cut -c1-13)"
PW="Tier781-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
reg() { # suffix [extra curl args] → "user company token"
  local s="$1"; shift
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" "$@" \
    -d "{\"email\":\"$TAG-$s@example.test\",\"password\":\"$PW\",\"companyName\":\"$TAG $s GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user']['companyId'], d['sessionToken'])" 2>/dev/null
}
req() { # method path token body [extra] → status; body in $D/out
  local m="$1" p="$2" t="$3" b="$4"; shift 4
  curl -sS -o "$D/out" -w '%{http_code}' -X "$m" "$API$p" -H "Content-Type: application/json" \
    -H "Authorization: Bearer $t" -H "x-company-id: $C" "$@" ${b:+-d "$b"}
}
field() { python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1') or '')
except Exception: print('')" < "$D/out"; }

read -r A C AT < <(reg admin)
read -r B _ BT < <(reg member)
q "insert into \"UserCompany\" (\"userId\", \"companyId\", role) values ('$B', '$C', 'accountant')" >/dev/null
[[ -n "${AT:-}" && -n "${BT:-}" ]] && pass "fixture: a company with its admin and an accountant, both with sessions" || { fail "register"; summary; exit 1; }

note "=== a public route with another company's ids in the headers ==="
trail() { q "select count(*) from \"AuditLog\" where \"companyId\"='$C'"; }
before=$(trail)
read -r X XC _ < <(reg stranger -H "x-company-id: $C" -H "x-user-id: $A")
[[ -n "${XC:-}" ]] && pass "an anonymous registration with company C's ids in the headers: 201" || fail "register"
assert_eq "C's trail got no row from it (was company.created + usercompany.created)" "$(( $(trail) - before ))" "0"
assert_eq "…the new company's own trail has its company.created" "$(q "select count(*) from \"AuditLog\" where \"companyId\"='$XC' and action='company.created'")" "1"
assert_eq "…under no user (was C's admin)" "$(q "select count(*) from \"AuditLog\" where \"companyId\"='$XC' and \"userId\" is not null and action in ('company.created','usercompany.created')")" "0"
# (x-user-id is still a credential outside production — ALLOW_HEADER_AUTH —
# so the error report names a user who is not C's)
before=$(trail)
curl -sS -o /dev/null -X POST "$API/api/v1/system/errors" -H "Content-Type: application/json" \
  -H "x-company-id: $C" -H "x-user-id: $X" -d "{\"message\":\"$TAG anonymous error\"}"
assert_eq "an error report with C's id and a stranger's: nothing in C's trail (was 1 row)" "$(( $(trail) - before ))" "0"

note "=== the author of an internal note is the signed-in user ==="
req POST "/api/v1/customers?companyId=$C" "$AT" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}" >/dev/null
K=$(field id)
st=$(req POST "/api/v1/customers/$K/internal-notes?companyId=$C" "$BT" '{"body":"von B"}' -H "x-user-id: $A" -H "x-user-email: chef@example.test")
NB=$(field id)
assert_eq "the accountant's note, with the admin's id and a made-up e-mail in the headers: 201" "$st" "201"
assert_eq "…its author is the accountant (was the admin)" "$(q "select \"userId\" from \"CustomerInternalNote\" where id='$NB'")" "$B"
assert_eq "…with the accountant's address (was the made-up one)" "$(q "select \"userEmail\" from \"CustomerInternalNote\" where id='$NB'")" "$TAG-member@example.test"
req POST "/api/v1/customers/$K/internal-notes?companyId=$C" "$AT" '{"body":"vom Admin"}' >/dev/null
NA=$(field id)
assert_eq "the admin's note with the session alone has an author (was none)" "$(q "select \"userId\" from \"CustomerInternalNote\" where id='$NA'")" "$A"

st=$(req DELETE "/api/v1/customers/$K/internal-notes/$NA?companyId=$C" "$BT" "" -H "x-user-id: $A")
assert_eq "the accountant deletes the admin's note, naming the admin in the header: refused (was 200)" "$st" "400"
assert_eq "…the note is there" "$(q "select count(*) from \"CustomerInternalNote\" where id='$NA'")" "1"
st=$(req DELETE "/api/v1/customers/$K/internal-notes/$NB?companyId=$C" "$AT" "")
assert_eq "the admin deletes the accountant's note: 200 (an admin was not recognised)" "$st" "200"
req POST "/api/v1/customers/$K/internal-notes?companyId=$C" "$BT" '{"body":"eigene"}' >/dev/null
NB2=$(field id)
st=$(req DELETE "/api/v1/customers/$K/internal-notes/$NB2?companyId=$C" "$BT" "")
assert_eq "the accountant deletes an own note with the session alone: 200 (was 400)" "$st" "200"

req POST "/api/v1/invoices?companyId=$C" "$AT" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}" >/dev/null
I=$(field id)
st=$(req POST "/api/v1/invoices/$I/internal-notes?companyId=$C" "$BT" '{"body":"zur Rechnung"}' -H "x-user-id: $A")
NI=$(field id)
assert_eq "an invoice note: 200" "$st" "200"
assert_eq "…its author is the accountant (was the header's)" "$(q "select \"userId\" from \"InvoiceInternalNote\" where id='$NI'")" "$B"

summary
