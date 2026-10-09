#!/bin/bash
# Tiers 629–630 — a refusal names the role it takes; the SMTP password at rest
#
# Every route was called as a viewer, as an accountant and in read-only mode
# (477 requests each): no write got through that should not. What a member
# sees was the problem — „Unzureichende Berechtigung: users.read“ on the
# dunning-fee settings, where `users.read` only stands for "admin".
# 629: the 403 of the roles guard (and of UsersService.requireRole) carries
#      `action`, `requiredRole` and the caller's `role`; the message is
#      unchanged. The frontend turns it into a sentence.
# 630: MailConfig.smtpPassword was stored as typed. It is sealed now
#      (AES-256-GCM under the installation's FINTS_PIN_ENC_KEY, as
#      "enc:v1:…"); GET /mail/config says so. And a company without a mail
#      configuration no longer gets the installation's SMTP host and account
#      name as "initial values" — only whether the installation sends for it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-374-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
register() { # suffix → prints "user company"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier629-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
AS() { # user method path [body] [extra header]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${5:+-H "$5"} ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
stored() { q "select \"smtpPassword\" from \"MailConfig\" where \"companyId\"='$C'"; }

read -r UA C < <(register admin)
read -r UV _ < <(register viewer)
read -r UC _ < <(register buchhalter)
[[ -n "${C:-}" && -n "$UV" && -n "$UC" ]] && pass "fixture: a company, and two more users" || { fail "register"; summary; exit 1; }
q "INSERT INTO \"UserCompany\" (\"userId\",\"companyId\",role) VALUES ('$UV','$C','viewer'), ('$UC','$C','accountant')" >/dev/null

note "=== 629. the refusal says which role it takes ==="
AS "$UV" PUT "/api/v1/mail/config?companyId=$C" '{}'
assert_eq "a viewer changing the mail configuration: 403, with the action, the role it takes and the viewer's own (was: the message alone)" \
  "$STATUS $(field "d['message'], d['action'], d['requiredRole'], d['role']")" "403 ('Unzureichende Berechtigung: company.update', 'company.update', 'admin', 'viewer')"
AS "$UV" GET "/api/v1/audit-logs?companyId=$C"
assert_eq "…reading the audit log takes an accountant" "$STATUS $(field "d['requiredRole'], d['role']")" "403 ('accountant', 'viewer')"
AS "$UC" GET "/api/v1/reminders/mahnungen/fees-config?companyId=$C"
assert_eq "an accountant at the dunning-fee settings: the action is called users.read — the role it takes is 'admin'" "$STATUS $(field "d['action'], d['requiredRole'], d['role']")" "403 ('users.read', 'admin', 'accountant')"
AS "$UV" GET "/api/v1/users?companyId=$C"
assert_eq "the users list (refused inside the service) answers the same way" "$STATUS $(field "d['requiredRole'], d['message']")" "403 ('admin', 'Unzureichende Berechtigung: users.read')"
AS "$UA" POST "/api/v1/customers?companyId=$C" '{"name":"x"}' "x-readonly: 1"
assert_eq "read-only mode is no question of the role: its own message, no requiredRole" "$STATUS $(field "'Read-Only Modus' in d['message'], d.get('requiredRole')")" "403 (True, None)"
AS "$UC" POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
AS "$UV" GET "/api/v1/customers?companyId=$C"
assert_eq "what the roles may do is unchanged: the accountant creates a customer, the viewer reads it" "$STATUS $(field "len(d['data'])")" "200 1"

note "=== 630. the SMTP password is not kept as typed ==="
AS "$UA" GET "/api/v1/mail/config?companyId=$C"
assert_eq "a company without a mail configuration gets no host and no account — only whether the installation sends for it" \
  "$STATUS $(field "d['configured'], d['smtpHost'], d['smtpUser'], d['fromEmail'], isinstance(d['installationSender'], bool)")" "200 (False, '', '', '', True)"
SECRET="Geheim-$TAG-Passwort"
AS "$UA" PUT "/api/v1/mail/config?companyId=$C" '{"smtpHost":"smtp.example.test","smtpPort":587,"smtpUser":"mailer@example.test","smtpPassword":"'$SECRET'","fromEmail":"rechnung@example.test","fromName":"Test","enabled":true}'
AS "$UA" GET "/api/v1/mail/config?companyId=$C"
[[ "$(field "d['encryptionAvailable']")" == "True" ]] && pass "the backend runs with the installation's key (FINTS_PIN_ENC_KEY)" || fail "the backend under test has no FINTS_PIN_ENC_KEY — CI and local-ci-stack.sh set one; without it a password is stored as typed"
FIRST=$(stored)
assert_eq "the password is stored sealed, not as typed (was: as typed)" "${FIRST:0:7}/$(echo "$FIRST" | grep -c "$SECRET")/$(q "select count(*) from \"MailConfig\" where \"smtpPassword\" like '%$SECRET%'")" "enc:v1:/0/0"
assert_eq "the configuration says so, and still never returns the password" "$(field "d['passwordEncrypted'], d['smtpPassword'], d['smtpUser']")" "(True, '', 'mailer@example.test')"
AS "$UA" PUT "/api/v1/mail/config?companyId=$C" '{"smtpHost":"smtp2.example.test","smtpPort":587,"smtpUser":"mailer@example.test","smtpPassword":"","fromEmail":"rechnung@example.test"}'
assert_eq "saving without a password keeps the stored one" "$STATUS $([[ "$(stored)" == "$FIRST" ]] && echo same || echo changed)" "200 same"
AS "$UA" PUT "/api/v1/mail/config?companyId=$C" '{"smtpHost":"smtp2.example.test","smtpPort":587,"smtpUser":"mailer@example.test","smtpPassword":"'$SECRET'","fromEmail":"rechnung@example.test"}'
assert_eq "the same password typed again is sealed anew (a fresh IV — two rows never look alike)" "$([[ "$(stored)" != "$FIRST" && "$(stored)" == enc:v1:* ]] && echo different || echo same)" "different"
q "update \"MailConfig\" set \"smtpPassword\"='alt-im-klartext' where \"companyId\"='$C'" >/dev/null
AS "$UA" GET "/api/v1/mail/config?companyId=$C"; A=$(field "d['passwordEncrypted']")
AS "$UA" PUT "/api/v1/mail/config?companyId=$C" '{"smtpHost":"smtp2.example.test","smtpPort":587,"smtpUser":"mailer@example.test","smtpPassword":""}'
assert_eq "a password from before (stored plain) is reported as such, and sealed by the next save" "$A $(stored | cut -c1-7)" "False enc:v1:"
PROBE=$(cd "$SCRIPT_DIR/.." && FINTS_PIN_ENC_KEY=key-one npx ts-node -e "
import { sealSecret, openSecret, isSealed } from './src/common/secret-crypto'
const sealed = sealSecret('pässwört;:1')
const a = [isSealed(sealed), openSecret(sealed) === 'pässwört;:1', openSecret('plain-from-before') === 'plain-from-before', sealSecret(sealed) === sealed, openSecret(sealed.slice(0, -4) + 'AAAA') === null]
process.env.FINTS_PIN_ENC_KEY = 'key-two'
a.push(openSecret(sealed) === null)
delete process.env.FINTS_PIN_ENC_KEY
a.push(openSecret(sealed) === null, sealSecret('x') === 'x')
console.log(a.join(' '))" 2>&1 | tail -1)
assert_eq "sealed and opened again; a plain value is read as it is; sealing twice does nothing; a damaged value, another key, no key: no password — and without a key nothing is sealed" \
  "$PROBE" "true true true true true true true true"
summary
