#!/bin/bash
# Tier 737 — the person's own data (Art. 15 / 20 DSGVO), and deleting the account
#
# There was neither: no export of what the installation keeps about a person,
# no way to end an account or a company (§9 item 22). Now:
#   1. GET /auth/my-data — the account, memberships, sign-ins, the person's
#      audit rows, invitations, e-mails sent; no secrets.
#   2. GET /auth/delete-account/check — what deleting would do: a company
#      whose last admin the person is while others remain blocks it; one whose
#      only member the person is is closed with the account.
#   3. POST /auth/delete-account — password again, consent to the closing;
#      the account is anonymised (records keep pointing at it, nothing names
#      the person), sessions, memberships and the signing key go.
#   4. A closed company: nobody gets in (a leftover grant answers 403), its
#      payment links and portal sessions end, no scheduled job selects it,
#      its records stay — until 31.12. of the tenth year (§ 147 AO).
#   5. The operator's company (the oldest) is never closed this way.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
TAG="e2e-457-$(date +%s%N | cut -c1-13)"
YEAR=$(date +%Y)
register() { # email → U C
  local body="{\"email\":\"$1\",\"password\":\"Tier737-e2e\",\"companyName\":\"$TAG $2\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -D /tmp/t457-headers -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
signin() { # email password → session token
  local body="{\"email\":\"$1\",\"password\":\"$2\"}"
  curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))"
}

note "=== 1. my data ==="
read -r UA CA < <(register "$TAG-a@example.test" "Alpha GmbH")
[[ -n "${CA:-}" ]] && pass "fixture: Alpha, one member" || { fail "register"; summary; exit 1; }
fixture_issuer "$CA" DE811111111
TA=$(signin "$TAG-a@example.test" "Tier737-e2e")
CUST="{\"name\":\"Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
AS "$UA" "$CA" POST "/api/v1/customers?companyId=$CA" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS "$UA" "$CA" POST "/api/v1/invoices?companyId=$CA" "$INV"
I=$(json_field "$BODY" id)
AS "$UA" "$CA" PUT "/api/v1/invoices/$I/status?companyId=$CA" '{"status":"sent"}'
AS "$UA" "$CA" POST "/api/v1/invoices/$I/generate-payment-link?companyId=$CA" '{"origin":"http://localhost:3100"}'
LT=$(P "d.get('token') or d.get('url','').rstrip('/').rsplit('/',1)[-1]")
PORTAL="{\"customerId\":\"$K\"}"
AS "$UA" "$CA" POST "/api/v1/customer-portal/admin/create-session?companyId=$CA" "$PORTAL"
PT=$(P "d.get('url','')" | sed -n 's/.*token=\([0-9a-f]\{64\}\).*/\1/p')
[[ -n "$LT" && -n "$PT" ]] && pass "fixture: an issued invoice, its payment link, a portal session" || fail "fixture: link=$LT portal=$PT"

AS "$UA" "$CA" GET /api/v1/auth/my-data
assert_eq "my data: 200, a download" "$STATUS/$(grep -ci 'content-disposition: attachment; filename="meine-daten-' /tmp/t457-headers)" "200/1"
assert_eq "…the account, the membership, the sign-ins with IP address" \
  "$(P "(d['account']['email'], [(m['companyId'], m['role']) for m in d['memberships']], len(d['sessions']) >= 1, 'ipAddress' in d['sessions'][0])")" \
  "('$TAG-a@example.test', [('$CA', 'admin')], True, True)"
assert_eq "…the person's audit rows (the sign-in among them)" "$(P "'login_success' in [a['action'] for a in d['activity']]")" "True"
SECRETS=$(python3 -c "import sys;s=sys.argv[1];print([k for k in ('passwordHash','twoFactorSecret','recoveryCodes','\"token\"','emailVerifyTokenHash','\$2b\$') if k in s])" "$BODY")
assert_eq "…no secrets: no password hash, 2FA secret, recovery codes, token" "$SECRETS" "[]"
assert_eq "an audit row personal_data_exported" "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE action='personal_data_exported' AND \"userId\"='$UA';")" "1"

note "=== 2. what deleting would do ==="
AS "$UA" "$CA" GET /api/v1/auth/delete-account/check
assert_eq "Alpha's only member: Alpha is closed with the account, kept until 31.12.$((YEAR+10))" \
  "$(P "([b['companyId'] for b in d['blockers']], [(c['companyId'], c['retentionUntil'][:10]) for c in d['closes']])")" "([], [('$CA', '$((YEAR+10))-12-31')])"

read -r UB CB < <(register "$TAG-b@example.test" "Beta GmbH")
INVITE="{\"email\":\"$TAG-m@example.test\",\"role\":\"accountant\"}"
AS "$UB" "$CB" POST "/api/v1/users/invitations?companyId=$CB" "$INVITE"
ITOKEN=$(grep -o "register?invite=[A-Za-z0-9_-]*" /tmp/backend.log | tail -1 | cut -d= -f2)
ACCEPT="{\"token\":\"$ITOKEN\",\"password\":\"Tier737-mem1\"}"
UM=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" -d "$ACCEPT" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))")
[[ -n "$UM" ]] && pass "fixture: Beta — an admin and an accountant" || fail "fixture: the accountant"
AS "$UB" "$CB" GET /api/v1/auth/delete-account/check
assert_eq "Beta's last admin, with a member left: blocked, nothing closed" \
  "$(P "([(b['companyId'], b['reason']) for b in d['blockers']], d['closes'])")" "([('$CB', 'last-admin')], [])"
DEL_B="{\"password\":\"Tier737-e2e\",\"closeCompanies\":true}"
AS "$UB" "$CB" POST /api/v1/auth/delete-account "$DEL_B"
assert_eq "…and the deletion is refused, naming Beta" "$STATUS/$(P "'Beta GmbH' in d['message'] and 'Administrator' in d['message']")" "400/True"
AS "$UM" "$CB" GET /api/v1/auth/delete-account/check
assert_eq "the accountant: leaves Beta, nothing blocked or closed" \
  "$(P "(d['blockers'], d['closes'], [l['companyId'] for l in d['leaves']])")" "([], [], ['$CB'])"

note "=== 3. delete Alpha's account ==="
AS "$UA" "$CA" POST /api/v1/auth/delete-account '{"password":"falsch-123","closeCompanies":true}'
assert_eq "a wrong password: 400" "$STATUS" "400"
AS "$UA" "$CA" POST /api/v1/auth/delete-account '{"password":"Tier737-e2e"}'
assert_eq "without consent to closing Alpha: 400, names it" "$STATUS/$(P "'Alpha GmbH' in d['message']")" "400/True"
assert_eq "…nothing changed yet" "$(sql "SELECT status, \"closedAt\" IS NULL FROM \"User\" u JOIN \"Company\" c ON c.id='$CA' WHERE u.id='$UA';")" "active|t"
DEL_A="{\"password\":\"Tier737-e2e\",\"closeCompanies\":true}"
AS "$UA" "$CA" POST /api/v1/auth/delete-account "$DEL_A"
assert_eq "deleted: 200, Alpha closed, the cookie cleared" \
  "$STATUS/$(P "[c['companyId'] for c in d['closedCompanies']]")/$(grep -ci 'set-cookie: de_session=;' /tmp/t457-headers)" "200/['$CA']/1"
assert_eq "the account anonymised: no address, no password, no 2FA, status deleted" \
  "$(sql "SELECT email LIKE 'geloescht-%@deleted.invalid', status, \"companyId\" IS NULL, profile IS NULL, \"twoFactorSecret\" IS NULL, \"emailVerifiedAt\" IS NULL FROM \"User\" WHERE id='$UA';")" "t|deleted|t|t|t|t"
assert_eq "…no memberships, sessions or signing key left" \
  "$(sql "SELECT (SELECT count(*) FROM \"UserCompany\" WHERE \"userId\"='$UA') + (SELECT count(*) FROM \"UserSession\" WHERE \"userId\"='$UA') + (SELECT count(*) FROM \"UserSigningKey\" WHERE \"userId\"='$UA');")" "0"
assert_eq "the old session no longer opens anything" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/auth/me" -H "Authorization: Bearer $TA")" "401"
assert_eq "the old address and password no longer sign in" "$(signin "$TAG-a@example.test" "Tier737-e2e")" ""
assert_eq "the invoice is kept, and the audit rows still carry the (anonymised) account's id" \
  "$(sql "SELECT status FROM \"Invoice\" WHERE id='$I';")/$(sql "SELECT count(*) > 0 FROM \"AuditLog\" WHERE \"userId\"='$UA' AND \"entityId\"='$I';")" "sent/t"
assert_eq "audit rows company_closed and account_deleted" \
  "$(sql "SELECT string_agg(action, ',' ORDER BY action) FROM \"AuditLog\" WHERE \"userId\"='$UA' AND action IN ('company_closed','account_deleted');")" "account_deleted,company_closed"
assert_eq "the address can register again (a new account)" "$(register "$TAG-a@example.test" "Alpha neu GmbH" | wc -w | tr -d ' ')" "2"

note "=== 4. the closed company ==="
assert_eq "Alpha: closedAt, closedById, retentionUntil 31.12.$((YEAR+10))" \
  "$(sql "SELECT \"closedAt\" IS NOT NULL, \"closedById\", to_char(\"retentionUntil\",'YYYY-MM-DD') FROM \"Company\" WHERE id='$CA';")" "t|$UA|$((YEAR+10))-12-31"
sql "INSERT INTO \"UserCompany\" (\"userId\", \"companyId\", role) VALUES ('$UB', '$CA', 'admin');" >/dev/null
AS "$UB" "$CA" GET "/api/v1/invoices?companyId=$CA"
assert_eq "a grant left over opens nothing: 403, says closed" "$STATUS/$(P "'geschlossen' in d['message']")" "403/True"
sql "DELETE FROM \"UserCompany\" WHERE \"userId\"='$UB' AND \"companyId\"='$CA';" >/dev/null
assert_eq "the payment link is revoked" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/portal/$LT")/$(sql "SELECT \"revokedAt\" IS NOT NULL FROM \"PaymentLink\" WHERE token='$LT';")" "404/t"
assert_eq "the portal session has ended" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoices?token=$PT")" "401"

# The scheduled jobs walk every company of the database; firing them here would
# act on the other specs' data. Their selection is checked in the source.
SRC="$SCRIPT_DIR/../src/modules"
missing=""
for f in reminder/auto-reminder.scheduler.ts assets/afa-auto-booker.scheduler.ts recurring/recurring.service.ts fints/fints.service.ts \
         webhook/webhook.service.ts vat-validation/vat-reverify.scheduler.ts invoice/overdue-status.scheduler.ts; do
  grep -q "closedAt: null" "$SRC/$f" || missing="$missing $f"
done
assert_eq "every scheduled job that acts on a company leaves a closed one alone" "${missing:-none}" "none"
assert_eq "…the AfA booker in both of its runs" "$(grep -c 'closedAt: null' "$SRC/assets/afa-auto-booker.scheduler.ts")" "2"

note "=== 5. the accountant leaves Beta ==="
AS "$UM" "$CB" POST /api/v1/auth/delete-account '{"password":"Tier737-mem1"}'
assert_eq "deleted, nothing closed" "$STATUS/$(P "d['closedCompanies']")" "200/[]"
assert_eq "Beta stays open with its admin" "$(sql "SELECT c.\"closedAt\" IS NULL, (SELECT count(*) FROM \"UserCompany\" WHERE \"companyId\"='$CB') FROM \"Company\" c WHERE id='$CB';")" "t|1"
AS "$UB" "$CB" GET /api/v1/auth/delete-account/check
assert_eq "…and Beta's admin, now alone, would close it" "$(P "([b for b in d['blockers']], [c['companyId'] for c in d['closes']])")" "([], ['$CB'])"

note "=== 6. the operator's company is not closed through an account ==="
# The operator is an admin of the oldest company (isSystemAdmin). Beta is made
# the oldest for a moment; the trap puts its date back whatever happens.
BETA_CREATED=$(sql "SELECT \"createdAt\" FROM \"Company\" WHERE id='$CB';")
trap 'sql "UPDATE \"Company\" SET \"createdAt\"='"'"'$BETA_CREATED'"'"' WHERE id='"'"'$CB'"'"';" >/dev/null' EXIT
sql "UPDATE \"Company\" SET \"createdAt\"='1999-01-01' WHERE id='$CB';" >/dev/null
AS "$UB" "$CB" GET /api/v1/auth/delete-account/check
assert_eq "the operator's company, its only member: blocked, not closed" \
  "$(P "([(b['companyId'], b['reason']) for b in d['blockers']], d['closes'])")" "([('$CB', 'operator-company')], [])"
AS "$UB" "$CB" POST /api/v1/auth/delete-account "$DEL_B"
assert_eq "…the deletion refused, saying why" "$STATUS/$(P "'Betreibers' in d['message']")" "400/True"
assert_eq "…Beta open, its admin active" "$(sql "SELECT c.\"closedAt\" IS NULL, u.status FROM \"Company\" c, \"User\" u WHERE c.id='$CB' AND u.id='$UB';")" "t|active"
sql "UPDATE \"Company\" SET \"createdAt\"='$BETA_CREATED' WHERE id='$CB';" >/dev/null
trap - EXIT

summary
