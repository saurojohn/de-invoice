#!/bin/bash
# Tier 877 — three things a first day on the production images showed
#
# A walk through a fresh production stack (the images of Tier 876, a fresh
# database, hardened): the setup link, the administrator sent to set up 2FA,
# the dashboard, an invoice issued, printed (no CSP violation) and refused by
# mail without a server, sign-out and sign-in with the code. Found on it:
#   1. after the password, the 2FA page's address carried the e-mail address
#      (/login/verify-2fa?email=…) — into the browser's history and the
#      proxy's access log; the page has it from pending2faEmail;
#   2. an off-site copy that never ran was told „no copy for more than 6 h“
#      (as if there had been one) — it now says the service has not reported
#      and how it is started;
#   3. the note on a production installation's backup page showed
#      `infra/prod/restore-drill.sh` with its backticks.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
FE="$SCRIPT_DIR/../../frontend"
assert_eq "1. the sign-in goes to the 2FA page without the e-mail in the address" \
  "$(grep -c 'verify-2fa?email' "$FE/src/components/LoginForm.tsx")/$(grep -c 'router.push("/login/verify-2fa")' "$FE/src/components/LoginForm.tsx")" "0/1"
assert_eq "…the page takes it from pending2faEmail" "$(grep -c 'localStorage.getItem("pending2faEmail")' "$FE/src/app/login/verify-2fa/page.tsx")" "1"
assert_eq "2. a copy that never reported gets its own words (de/en/zh)" \
  "$(grep -c 'autoOffsiteNeverRan' "$FE/src/app/dashboard/backups/page.tsx")/$(python3 -c "
import json
print(sum(1 for l in ('de','en','zh') if 'offsite-backup' in json.load(open('$FE/messages/'+l+'.json'))['backup'].get('autoOffsiteNeverRan','')))")" "1/3"
assert_eq "3. no backtick in the note of an installation without manual backups" \
  "$(python3 -c "
import json
print(sum(json.load(open('$FE/messages/'+l+'.json'))['backup']['manualUnavailable'].count('\`') for l in ('de','en','zh')))")" "0"
summary
