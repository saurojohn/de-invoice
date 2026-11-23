#!/bin/bash
# Tier 963 — the owner's private income-tax annexes and the Berater-Paket
#
# Anlage N / R / Kind (and KAP, V, AUS, SO) were 'accounting.read' — every
# viewer, and the time-limited tax-auditor access, read the owner's children,
# salary and pensions. The Berater-Paket (the same right) carried them, and
# the UStJA a viewer is refused. Measured: a viewer GET anlage-kind 200 with
# the child's name; GET ustva/ustja 403, the package's 05_UStJA.pdf 200.
# Now a right of their own: accountant and up, never the auditor
# (§ 147 Abs. 6 AO covers the records of § 147 Abs. 1 AO).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-650-$(date +%s%N | cut -c1-13)"
UNTIL=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier963-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader and its owner" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # user method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS "$U" PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"euer"}'
member() { # role [accessUntil] → user id
  local email="$TAG-$1@example.test"
  AS "$U" POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$email\",\"role\":\"$1\"${2:+,\"accessUntil\":\"$2\"}}"
  local tok; tok=$(invite_token "$email")
  curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" \
    -d "{\"token\":\"$tok\",\"password\":\"Tier963-member\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))"
}
V=$(member viewer)
A=$(member auditor "$UNTIL")
[[ -n "$V" && -n "$A" ]] && pass "fixture: a viewer and a tax auditor" || fail "members"

for path in anlage-kind anlage-n anlage-r anlage-kap anlage-v anlage-so anlage-aus anlage-kind.pdf; do
  AS "$U" GET "/api/v1/accounting/$path?companyId=$C&year=2025"; OWN=$STATUS
  AS "$V" GET "/api/v1/accounting/$path?companyId=$C&year=2025"; VIEW=$STATUS
  AS "$A" GET "/api/v1/accounting/$path?companyId=$C&year=2025"; AUD=$STATUS
  assert_eq "$path: the owner reads it, the viewer and the auditor not (was 200 for both)" "$OWN/$VIEW/$AUD" "200/403/403"
done
AS "$V" GET "/api/v1/accounting/berater-packager?companyId=$C&year=2025"
assert_eq "the Berater-Paket (with the UStJA and the annexes): not for the viewer (was 200)" "$STATUS" "403"
AS "$A" GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "…the business annexes stay readable by the auditor" "$STATUS" "200"

summary
