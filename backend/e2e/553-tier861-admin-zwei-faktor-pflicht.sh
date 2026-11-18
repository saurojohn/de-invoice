#!/bin/bash
# Tier 861 — a company can require its administrators to sign in with 2FA
#
# Security audit (18.11.2026), item 8: 2FA was optional for everybody; an
# administrator's password alone opened the books, the users, the bank and
# the settings. The owner chose (18.11.2026): a setting of each company, on
# by default in production. An administrator without 2FA in such a company
# reaches only what setting it up takes; turning the rule off takes an
# administrator with 2FA.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
BACKEND_DIR="$SCRIPT_DIR/.."
TAG="e2e-553-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
AS() { # user method path [body] → STATUS, BODY (in company C)
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2]))
except Exception: print('-')" "$BODY" "$1"; }

note "=== 1. the rule ==="
OUT=$(cd "$BACKEND_DIR" && ./node_modules/.bin/ts-node -T -e "
import { adminTwoFactorPolicy, allowedWithoutTwoFactor } from './src/auth/admin-two-factor'
const p = (s: unknown, e: string) => { const r = adminTwoFactorPolicy(s, { NODE_ENV: e }); return r.required + '/' + r.source }
console.log([p({}, 'production'), p(null, 'test'), p({ requireAdmin2fa: false }, 'production'), p({ requireAdmin2fa: true }, 'test')].join(' '))
console.log(['GET /api/v1/auth/me', 'POST /api/v1/auth/2fa/enable?x=1', 'GET /api/v1/customers', 'PUT /api/v1/auth/2fa/policy', 'PUT /api/v1/auth/registration'].map((x) => allowedWithoutTwoFactor(x.split(' ')[0], x.split(' ')[1])).join(' '))
" 2>&1)
assert_eq "unset: on in production, off elsewhere; the company's choice wins" "$(sed -n 1p <<<"$OUT")" "true/default false/default false/setting true/setting"
assert_eq "without 2FA: who am I, set it up — not the books, not the rule, not the registration" "$(sed -n 2p <<<"$OUT")" "true true false false false"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier861-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: an administrator" || { fail "register"; summary; exit 1; }
read -r A _ < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-acc@example.test\",\"password\":\"Tier861-e2e\",\"companyName\":\"$TAG-acc GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
sql "insert into \"UserCompany\" (\"userId\", \"companyId\", role) values ('$A', '$C', 'accountant')" >/dev/null
AS "$A" GET "/api/v1/customers?companyId=$C"
assert_eq "fixture: an accountant of the same company" "$STATUS" "200"

note "=== 2. the rule off (the default outside production) ==="
AS "$U" GET /api/v1/auth/2fa/policy
assert_eq "the company has not chosen: off here" "$STATUS $(field requireAdmin2fa) $(field source)" "200 False default"
AS "$U" GET "/api/v1/customers?companyId=$C"
assert_eq "the administrator without 2FA works as before" "$STATUS" "200"

note "=== 3. the company turns it on ==="
AS "$A" PUT /api/v1/auth/2fa/policy '{"requireAdmin2fa":true}'
assert_eq "an accountant cannot" "$STATUS" "403"
AS "$U" PUT /api/v1/auth/2fa/policy '{"requireAdmin2fa":"yes"}'
assert_eq "not a boolean: 400" "$STATUS" "400"
AS "$U" PUT /api/v1/auth/2fa/policy '{"requireAdmin2fa":true}'
assert_eq "the administrator turns it on" "$STATUS $(field requireAdmin2fa) $(field source)" "200 True setting"
AS "$U" GET "/api/v1/customers?companyId=$C"
assert_eq "now the administrator without 2FA is refused, with the code the frontend acts on" "$STATUS $(field code)" "403 TWO_FACTOR_REQUIRED"
assert_eq "…saying what to do" "$(field message | grep -c 'Richten Sie sie unter „Sicherheit“ ein')" "1"
AS "$U" GET "/api/v1/invoices?companyId=$C"
assert_eq "…everywhere (invoices too)" "$STATUS" "403"
AS "$U" GET /api/v1/auth/me
assert_eq "who am I: answered" "$STATUS" "200"
AS "$U" POST /api/v1/auth/2fa/status '{}'
assert_eq "the status says it is asked of this administrator" "$STATUS $(field enabled) $(field requiredForMe)" "201 False True"
AS "$U" PUT /api/v1/auth/2fa/policy '{"requireAdmin2fa":false}'
assert_eq "turning it off again without 2FA: refused" "$STATUS $(field code)" "403 TWO_FACTOR_REQUIRED"
AS "$A" GET "/api/v1/customers?companyId=$C"
assert_eq "the accountant is not asked" "$STATUS" "200"
AS "$A" POST /api/v1/auth/2fa/status '{}'
assert_eq "…and the status says so" "$(field requiredForMe)" "False"

note "=== 4. the administrator sets up 2FA ==="
AS "$U" POST /api/v1/auth/2fa/setup '{}'
SECRET=$(field secret)
assert_eq "setup is reachable" "$STATUS $([[ ${#SECRET} -ge 16 ]] && echo secret)" "201 secret"
while (( $(date +%s) % 30 >= 25 )); do sleep 1; done
CODE=$(cd "$BACKEND_DIR" && node -e "
const { authenticator } = require('otplib');
authenticator.options = { step: 30, window: 1, digits: 6 };
console.log(authenticator.generate('$SECRET'));")
AS "$U" POST /api/v1/auth/2fa/enable "{\"code\":\"$CODE\"}"
assert_eq "enable is reachable" "$STATUS $(field enabled)" "201 True"
AS "$U" GET "/api/v1/customers?companyId=$C"
assert_eq "with 2FA the administrator works again" "$STATUS" "200"
AS "$U" PUT /api/v1/auth/2fa/policy '{"requireAdmin2fa":false}'
assert_eq "…and may turn the rule off" "$STATUS $(field requireAdmin2fa)" "200 False"
assert_eq "both changes are in the audit log, before and after" \
  "$(sql "select string_agg((\"newData\"->>'before') || '>' || (\"newData\"->>'after'), ' ' order by \"createdAt\") from \"AuditLog\" where \"companyId\"='$C' and action='admin_2fa_policy_changed'")" "false>true true>false"
summary
