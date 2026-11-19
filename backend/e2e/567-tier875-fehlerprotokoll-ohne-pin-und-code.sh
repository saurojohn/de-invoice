#!/bin/bash
# Tier 875 — a request body stored with a server error carries no PIN, no 2FA code, no nested secret
#
# GlobalExceptionFilter keeps a 5xx with the request's body for the operator
# (ErrorEvent, the system page). It blanked keys with password / token /
# secret / hash and some personal data — at the first level only. A bank PIN
# (`pin`, FinTS), a 2FA `code` or `recoveryCode`, the sign-in `challenge`, or a
# password one object deeper were stored as they were.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
OUT=$(cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import { GlobalExceptionFilter } from './src/modules/system/system.filter'
const safe = (b: unknown) => (GlobalExceptionFilter.prototype as any).safeBody.call(GlobalExceptionFilter.prototype, b)
const r = safe({ blz: '50050201', pin: '12345', code: '123456', recoveryCode: 'abcd-efgh', challenge: 'c0ffee', label: 'Bank',
  smtp: { host: 'mail.example', smtpPassword: 'geheim', nested: { apiKey: 'k1' } }, items: [{ description: 'x', password: 'p' }],
  postalCode: '10115', countryCode: 'DE', email: 'a@b.de' })
console.log(JSON.stringify(r))
" 2>&1)
check() { python3 -c "import json,sys;d=json.loads(sys.argv[1]);print($1)" "$OUT"; }
assert_eq "a bank PIN, a 2FA code, a recovery code, the challenge: blanked (were stored as they were)" \
  "$(check "d['pin'], d['code'], d['recoveryCode'], d['challenge']")" "[redacted] [redacted] [redacted] [redacted]"
assert_eq "a password and a key one or two objects deeper, and in a list: blanked" \
  "$(check "d['smtp']['smtpPassword'], d['smtp']['nested']['apiKey'], d['items'][0]['password']")" "[redacted] [redacted] [redacted]"
assert_eq "the rest stays readable for the operator (postal code, country, the bank's code, labels)" \
  "$(check "d['blz'], d['postalCode'], d['countryCode'], d['label'], d['smtp']['host'], d['items'][0]['description']")" "50050201 10115 DE Bank mail.example x"
assert_eq "an address as before" "$(check "d['email']")" "[redacted]"
summary
