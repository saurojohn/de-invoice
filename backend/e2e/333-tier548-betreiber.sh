#!/bin/bash
# Tier 548 — the installation's operator, not every company's admin
#
# Registration is public, and whoever registers is the admin of the company
# they created. The routes that act on the whole installation asked for a
# company-level action only. Measured as the admin of a company registered a
# minute before: GET /admin/backups → 200 (every backup, with its path on the
# server), POST /admin/backups/run, DELETE /admin/backups/:id and POST
# /admin/backups/restore-drill reached their handlers, GET /admin/cron-health
# → 200, POST /admin/cron-health/:name/run (any scheduler, for all
# companies), the storage configuration, the operator's notification
# settings, POST /fints/auto-run (the bank sync of every company).
#
# Now those need the operator: SYSTEM_ADMIN_EMAILS when set, otherwise the
# admins of the oldest company (the one the installation was set up with —
# the suite's seed company). Another company's admin gets 403.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-333-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier548-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company registered just now, its admin" || { fail "register"; summary; exit 1; }
OLDEST=$(q "select id from \"Company\" order by \"createdAt\" asc limit 1")
assert_eq "fixture: the suite's company is the oldest — the operator's" "$OLDEST" "$COMPANY_ID"
as() { # who(new|op) method path [body] → status (body in /tmp/t548.out)
  local u=$U c=$C; [[ "$1" == op ]] && { u=$USER_ID; c=$COMPANY_ID; }
  curl -s -o /tmp/t548.out -w '%{http_code}' -m 60 -X "$2" "$API$3" -H "x-user-id: $u" -H "x-company-id: $c" -H "Content-Type: application/json" ${4:+-d "$4"}
}
BACKUPS=$(as op GET "/api/v1/admin/backups"; :) ; N_BEFORE=$(python3 -c "import json;print(len(json.load(open('/tmp/t548.out')).get('items',[])))" 2>/dev/null || echo "?")

note "=== a company's admin who is not the operator ==="
assert_eq "GET the backups: 403 (was 200, with server paths)" "$(as new GET "/api/v1/admin/backups")" "403"
assert_eq "…the message says whose this is" "$(grep -c "Betreiber der Installation" /tmp/t548.out)" "1"
assert_eq "POST a backup run: 403 (was run)" "$(as new POST "/api/v1/admin/backups/run" '{}')" "403"
assert_eq "DELETE a backup: 403 (was reached)" "$(as new DELETE "/api/v1/admin/backups/2026-01-01-000000")" "403"
assert_eq "POST a restore drill: 403 (was run)" "$(as new POST "/api/v1/admin/backups/restore-drill" '{}')" "403"
assert_eq "GET the schedulers: 403 (was 200)" "$(as new GET "/api/v1/admin/cron-health")" "403"
assert_eq "POST a scheduler run: 403 (was run for all companies)" "$(as new POST "/api/v1/admin/cron-health/recurring-invoices/run" '{}')" "403"
assert_eq "POST cron-health/clean: 403" "$(as new POST "/api/v1/admin/cron-health/clean" '{}')" "403"
assert_eq "GET the storage configuration: 403 (was 200, the server's path)" "$(as new GET "/api/v1/storage/config")" "403"
assert_eq "POST the storage configuration: 403" "$(as new POST "/api/v1/storage/config" '{"cloudEnabled":false}')" "403"
assert_eq "GET the operator's notification settings: 403 (was 200)" "$(as new GET "/api/v1/system/notifications/config")" "403"
assert_eq "PUT the alert threshold: 403 (was 200)" "$(as new PUT "/api/v1/system/notifications/threshold" '{"rateThresholdCount":1}')" "403"
assert_eq "POST fints/auto-run: 403 (was every company's bank sync)" "$(as new POST "/api/v1/fints/auto-run" '{}')" "403"

note "=== its own things stay its own ==="
assert_eq "its error list" "$(as new GET "/api/v1/system/errors")" "200"
assert_eq "its storage statistics" "$(as new GET "/api/v1/storage/stats?companyId=$C")" "200"
assert_eq "its users" "$(as new GET "/api/v1/users?companyId=$C")" "200"

note "=== the operator ==="
assert_eq "GET the backups: 200" "$(as op GET "/api/v1/admin/backups")" "200"
assert_eq "…as many as before — the refused requests ran and deleted nothing" "$(python3 -c "import json;print(len(json.load(open('/tmp/t548.out')).get('items',[])))")" "$N_BEFORE"
assert_eq "GET the schedulers: 200" "$(as op GET "/api/v1/admin/cron-health")" "200"
assert_eq "GET the storage configuration: 200" "$(as op GET "/api/v1/storage/config")" "200"
assert_eq "GET the notification settings: 200" "$(as op GET "/api/v1/system/notifications/config")" "200"
rm -f /tmp/t548.out

summary
