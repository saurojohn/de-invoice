#!/bin/bash
# Tier 785 — a session's row holds the token's hash, not the token
#
# A signed-in user's session (UserSession.token) and a customer's portal link
# (CustomerPortalSession.token) were stored as the 64 hex characters the
# browser sends. Measured: the value read from the table, sent as
# `Authorization: Bearer`, signed in as that user (200) and opened the
# customer's invoices — a copy of the database or of a backup was a set of
# working logins for 30 days. Now the row holds the SHA-256 of the token.
#
# The admin's portal link was built by reading the token back from the newest
# row; it now comes from the call that made the row.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TS=$(date +%s%N | cut -c1-13)
PW="Tier785-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
field() { python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'): d=d.get(k) if isinstance(d,dict) else None
  print(d if d is not None else '')
except Exception: print('')" < "$D/out"; }
code() { curl -sS -o "$D/out" -w '%{http_code}' "$@"; }
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

note "=== the user's session ==="
EMAIL="e2e-489-$TS@example.test"
st=$(code -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"companyName\":\"e2e-489 $TS GmbH\"}")
assert_eq "fixture: registered" "$st" "201"
U=$(field user.id); C=$(field user.companyId)
st=$(code -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
T=$(field sessionToken)
assert_eq "login: 200 with a session token" "$st/${#T}" "200/64"
assert_eq "the token itself is in no row (was stored as sent)" "$(q "select count(*) from \"UserSession\" where token='$T'")" "0"
assert_eq "…its SHA-256 is" "$(q "select count(*) from \"UserSession\" where token='$(sha "$T")' and \"userId\"='$U'")" "1"
st=$(code "$API/api/v1/auth/me" -H "Authorization: Bearer $T" -H "x-company-id: $C")
assert_eq "the token signs in: 200" "$st" "200"
st=$(code "$API/api/v1/auth/me" -H "Cookie: de_session=$T" -H "x-company-id: $C")
assert_eq "…as the cookie too: 200" "$st" "200"
STORED=$(q "select token from \"UserSession\" where \"userId\"='$U' order by \"createdAt\" desc limit 1")
st=$(code "$API/api/v1/auth/me" -H "Authorization: Bearer $STORED" -H "x-company-id: $C")
assert_eq "the value read from the table does not sign in: 401 (was 200)" "$st" "401"
st=$(code -X POST "$API/api/v1/auth/logout" -H "Authorization: Bearer $T")
assert_eq "logout with the token" "$st" "200"
assert_eq "…ends that row" "$(q "select \"revokedAt\" is not null from \"UserSession\" where token='$(sha "$T")'")" "t"
st=$(code "$API/api/v1/auth/me" -H "Authorization: Bearer $T" -H "x-company-id: $C")
assert_eq "…and the token is refused: 401" "$st" "401"

note "=== the customer's portal link ==="
st=$(code -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
T=$(field sessionToken)
A=(-H "Authorization: Bearer $T" -H "x-company-id: $C" -H "Content-Type: application/json")
st=$(code -X POST "$API/api/v1/customers?companyId=$C" "${A[@]}" -d "{\"name\":\"e2e-489 Kunde $TS\",\"type\":\"business\",\"contact\":{\"email\":\"kunde-489-$TS@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"Muenchen\",\"country\":\"DE\"}}")
K=$(field id)
assert_eq "fixture: a customer" "$st/${#K}" "201/36"
st=$(code -X POST "$API/api/v1/customer-portal/admin/create-session?companyId=$C" "${A[@]}" -d "{\"customerId\":\"$K\"}")
P=$(field url | sed -n 's/.*token=\([0-9a-f]\{64\}\).*/\1/p')
assert_eq "the admin's portal link: 201 with a token" "$st/${#P}" "201/64"
if [[ -n "$P" ]]; then
  assert_eq "the link's token is in no row" "$(q "select count(*) from \"CustomerPortalSession\" where token='$P'")" "0"
  assert_eq "…its SHA-256 is, for this customer" "$(q "select count(*) from \"CustomerPortalSession\" where token='$(sha "$P")' and \"customerId\"='$K' and \"companyId\"='$C'")" "1"
  st=$(code "$API/api/v1/customer-portal/invoices?token=$P")
  assert_eq "the link opens the portal: 200" "$st" "200"
  STORED=$(q "select token from \"CustomerPortalSession\" where \"customerId\"='$K' order by \"createdAt\" desc limit 1")
  st=$(code "$API/api/v1/customer-portal/invoices?token=$STORED")
  assert_eq "the value read from the table does not: 401" "$st" "401"
  st=$(code "$API/api/v1/customer-portal/profile?token=$STORED")
  assert_eq "…nor on the profile: 401" "$st" "401"
fi
st=$(code -X POST "$API/api/v1/customer-portal/admin/create-session?companyId=$C" "${A[@]}" -d "{\"customerId\":\"$K\"}")
P2=$(field url | sed -n 's/.*token=\([0-9a-f]\{64\}\).*/\1/p')
assert_eq "a second link is a new one" "$st/$([[ -n "$P2" && "$P2" != "${P:-}" ]] && echo new)" "201/new"

note "=== the link is not written to the log in production ==="
LINE=$(grep -n 'portal session created for' "$SCRIPT_DIR/../src/modules/customer-portal/customer-portal.service.ts" | head -1)
assert_eq "the log line leaves the token out under NODE_ENV=production" "$(grep -c "NODE_ENV === 'production' ? \`\${baseUrl}/portal\` : loginUrl" <<<"$LINE")" "1"

summary
