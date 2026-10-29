#!/bin/bash
# Tier 736 — the account's e-mail address is confirmed by a link sent to it
#
# Registration took any address typed into the form, and the company's mails
# (invoices, reminders, statements, invitations, portal links) went out
# through the installation's mail server at once — a relay for whoever signs
# up, under the operator's reputation. Now:
#   1. registration mails a link (72 h, SHA-256 of the token stored); /auth/me
#      says whether the address is confirmed; the link confirms it once.
#   2. a new link replaces the old one; confirmed is confirmed.
#   3. an accepted invitation and a password reset confirm the address too
#      (both links came to that mailbox).
#   4. until an admin of the company has confirmed their address, the
#      installation's server sends nothing for the company — refused before a
#      draft is issued. Checked live only when this backend has an
#      installation SMTP server (CI has none: nothing leaves, nothing is
#      refused); the mail config says which way it would go either way.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
LOG=/tmp/backend.log
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
TAG="e2e-456-$(date +%s%N | cut -c1-13)"
link() { grep -o "$1?token=[0-9a-f]*" "$LOG" | tail -1 | cut -d= -f2; }
register() { # email → U C (and the response in REG)
  local body="{\"email\":\"$1\",\"password\":\"Tier736-e2e\",\"companyName\":\"$TAG GmbH\"}"
  REG=$(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body")
}
ids() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" "$REG"; }
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
verify() { # token
  local body="{\"token\":\"$1\"}"
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/auth/verify-email" -H "Content-Type: application/json" -d "$body")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
me_verified() { AS "$1" "$2" GET /api/v1/auth/me; P "d['emailVerified']"; }

note "=== 1. registration mails a link; the link confirms the address once ==="
register "$TAG@example.test"
read -r U C < <(ids)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register: $REG"; summary; exit 1; }
assert_eq "the registration says: not confirmed, the link sent" \
  "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d['user']['emailVerified'], d['verificationMailSent'])" "$REG")" "False True"
assert_eq "/auth/me: emailVerified false" "$(me_verified "$U" "$C")" "False"
T1=$(link verify-email)
[[ ${#T1} -eq 64 ]] && pass "fixture: the link (logged outside production, as the reset link)" || { fail "no verify-email link in $LOG"; summary; exit 1; }
assert_eq "only the token's SHA-256 is stored, with an expiry about 72 h ahead" \
  "$(sql "SELECT \"emailVerifyTokenHash\" = encode(sha256('$T1'::bytea),'hex'), \"emailVerifyExpires\" BETWEEN now() + interval '71 hours' AND now() + interval '73 hours' FROM \"User\" WHERE id = '$U';")" "t|t"

AS "$U" "$C" GET "/api/v1/mail/config?companyId=$C"
assert_eq "the mail config: the installation does not send for the company yet" "$(P "d.get('installationMailAllowed')")" "False"

note "=== 2. a new link replaces the old one; wrong, expired and used links are refused ==="
AS "$U" "$C" POST /api/v1/auth/resend-verification
assert_eq "resend: 200" "$STATUS" "200"
T2=$(link verify-email)
[[ -n "$T2" && "$T2" != "$T1" ]] && pass "a new token" || fail "no new token"
verify "$T1"
assert_eq "the old link no longer works" "$STATUS/$(P "'ungültig oder abgelaufen' in d['message']")" "400/True"
verify "nonsense"
assert_eq "a malformed token: 400" "$STATUS" "400"
verify "$(printf 'a%.0s' $(seq 1 64))"
assert_eq "an unknown token: 400" "$STATUS" "400"
sql "UPDATE \"User\" SET \"emailVerifyExpires\" = now() - interval '1 minute' WHERE id = '$U';" >/dev/null
verify "$T2"
assert_eq "an expired link: 400" "$STATUS" "400"
assert_eq "…and the address is still unconfirmed" "$(me_verified "$U" "$C")" "False"
sql "UPDATE \"User\" SET \"emailVerifyExpires\" = now() + interval '1 hour' WHERE id = '$U';" >/dev/null
verify "$T2"
assert_eq "the current link confirms: 200, names the address" "$STATUS/$(P "d['email']")" "200/$TAG@example.test"
assert_eq "/auth/me: emailVerified true" "$(me_verified "$U" "$C")" "True"
assert_eq "the token is used up" "$(sql "SELECT \"emailVerifiedAt\" IS NOT NULL, \"emailVerifyTokenHash\" IS NULL FROM \"User\" WHERE id = '$U';")" "t|t"
verify "$T2"
assert_eq "the same link a second time: 400" "$STATUS" "400"
assert_eq "an audit row email_verified" "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE action = 'email_verified' AND \"entityId\" = '$U';")" "1"
AS "$U" "$C" POST /api/v1/auth/resend-verification
assert_eq "resend when confirmed: nothing sent, says so" "$STATUS/$(P "d.get('alreadyVerified')")" "200/True"
AS "$U" "$C" GET "/api/v1/mail/config?companyId=$C"
assert_eq "the mail config: the installation sends for the company now" "$(P "d.get('installationMailAllowed')")" "True"

note "=== 3. an invitation's and a reset's link confirm the address ==="
INVITE="{\"email\":\"$TAG-inv@example.test\",\"role\":\"accountant\"}"
AS "$U" "$C" POST "/api/v1/users/invitations?companyId=$C" "$INVITE"
assert_eq "fixture: an invitation" "$STATUS" "201"
ITOKEN=$(grep -o "register?invite=[A-Za-z0-9_-]*" "$LOG" | tail -1 | cut -d= -f2)
ACCEPT="{\"token\":\"$ITOKEN\",\"password\":\"Tier736-inv1\"}"
IU=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" -d "$ACCEPT" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('userId',''))")
[[ -n "$IU" ]] && pass "fixture: the invitation accepted" || fail "accept"
assert_eq "the invited member's address is confirmed" "$(sql "SELECT \"emailVerifiedAt\" IS NOT NULL FROM \"User\" WHERE id = '$IU';")" "t"

register "$TAG-b@example.test"
read -r UB CB < <(ids)
FORGOT="{\"email\":\"$TAG-b@example.test\"}"
curl -sS -o /dev/null -X POST "$API/api/v1/auth/forgot-password" -H "Content-Type: application/json" -d "$FORGOT"
RTOKEN=$(grep -o "reset-password?token=[A-Za-z0-9_-]*" "$LOG" | tail -1 | cut -d= -f2)
RESET="{\"token\":\"$RTOKEN\",\"password\":\"Tier736-new2\"}"
curl -sS -o /dev/null -X POST "$API/api/v1/auth/reset-password" -H "Content-Type: application/json" -d "$RESET"
assert_eq "a password reset by the mailed link confirms the address" "$(sql "SELECT \"emailVerifiedAt\" IS NOT NULL FROM \"User\" WHERE id = '$UB';")" "t"

note "=== 4. an unconfirmed company and the installation's mail server ==="
register "$TAG-c@example.test"
read -r UC CC < <(ids)
fixture_issuer "$CC" DE811111111
AS "$UC" "$CC" GET "/api/v1/mail/config?companyId=$CC"
INSTALLATION=$(P "d.get('installationSender')")
assert_eq "the mail config of an unconfirmed company: not allowed" "$(P "d.get('installationMailAllowed')")" "False"
CUST="{\"name\":\"Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
AS "$UC" "$CC" POST "/api/v1/customers?companyId=$CC" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS "$UC" "$CC" POST "/api/v1/invoices?companyId=$CC" "$INV"
I=$(json_field "$BODY" id)
SEND="{\"createdById\":\"$UC\"}"
AS "$UC" "$CC" POST "/api/v1/invoices/$I/send-email?companyId=$CC" "$SEND"
if [[ "$INSTALLATION" == "True" ]]; then
  assert_eq "with an installation SMTP: the send is refused, and says why" "$STATUS/$(P "'noch nicht bestätigt' in d['message']")" "400/True"
  assert_eq "…before the draft was issued" "$(sql "SELECT status FROM \"Invoice\" WHERE id = '$I';")" "draft"
  AS "$UC" "$CC" POST "/api/v1/users/invitations?companyId=$CC" "{\"email\":\"$TAG-c2@example.test\",\"role\":\"viewer\"}"
  assert_eq "…an invitation is refused before it exists" "$STATUS/$(sql "SELECT count(*) FROM \"UserInvitation\" WHERE \"companyId\" = '$CC';")" "400/0"
else
  note "this backend has no installation SMTP (CI): nothing leaves, so nothing is refused — the refusal was measured with one (HANDOFF Tier 736)"
  assert_eq "without an installation SMTP the send goes to the log as before" "$STATUS" "201"
fi

summary
