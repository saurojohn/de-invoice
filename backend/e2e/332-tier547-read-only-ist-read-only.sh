#!/bin/bash
# Tier 547 — read-only mode refuses every write; a re-verification is one company's
#
# Read-Only Modus (`x-readonly: 1`, the Berater's view) was checked by the
# route's action name. A sweep of every writing route in read-only mode found
# six that went through, because their action ends in `.read` or they carry
# none:
#   PATCH /users/:id/role (200), POST /users/invitations (201 — an admin
#   invited), POST /reminders/auto-run (201 — dunning mails), PUT
#   /reminders/mahnungen/fees-config (200), POST /admin/cron-health/clean
#   (201), POST /vat-validation/reverify-now (201).
# Now read-only mode goes by the request: nothing but GET — and the few POSTs
# that only read — goes through.
#
# And POST /vat-validation/reverify-now ran the re-verification for every
# company in the database and answered with their counts; it is the caller's
# company's now.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-332-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
reg() { curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier547-e2e\",\"companyName\":\"$TAG $1\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null; }
read -r U C < <(reg admin)
read -r V _ < <(reg second)
q "INSERT INTO \"UserCompany\" (\"userId\", \"companyId\", role) VALUES ('$V', '$C', 'viewer')" >/dev/null
[[ -n "${C:-}" && -n "$V" ]] && pass "fixture: a company, its admin, a viewer" || { fail "register"; summary; exit 1; }
call() { # readonly(0|1) method path body → status (body in /tmp/t547.out)
  local ro=(); [[ "$1" == 1 ]] && ro=(-H "x-readonly: 1")
  curl -s -o /tmp/t547.out -w '%{http_code}' -X "$2" "$API$3" -H "x-user-id: $U" -H "x-company-id: $C" ${ro[@]+"${ro[@]}"} -H "Content-Type: application/json" ${4:+-d "$4"}
}

note "=== read-only mode: the writes that went through ==="
assert_eq "PATCH a user's role: 403 (was 200)" "$(call 1 PATCH "/api/v1/users/$V/role?companyId=$C" '{"role":"admin"}')" "403"
assert_eq "…the message is the read-only one" "$(grep -c "Read-Only Modus aktiv — Schreibvorgang" /tmp/t547.out)" "1"
assert_eq "…the viewer is still a viewer" "$(q "select role from \"UserCompany\" where \"userId\"='$V' and \"companyId\"='$C'")" "viewer"
assert_eq "POST an invitation: 403 (was 201)" "$(call 1 POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"neu-$TAG@example.test\",\"role\":\"admin\"}")" "403"
assert_eq "POST reminders/auto-run: 403 (was 201)" "$(call 1 POST "/api/v1/reminders/auto-run?companyId=$C" '{}')" "403"
assert_eq "PUT the Mahngebühren: 403 (was 200)" "$(call 1 PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"mahngebuehr":{"first":99}}')" "403"
assert_eq "POST cron-health/clean: 403 (was 201)" "$(call 1 POST "/api/v1/admin/cron-health/clean?companyId=$C" '{}')" "403"
assert_eq "POST vat-validation/reverify-now: 403 (was 201)" "$(call 1 POST "/api/v1/vat-validation/reverify-now?companyId=$C" '{}')" "403"
assert_eq "PATCH a user's status: 403" "$(call 1 PATCH "/api/v1/users/$V/status?companyId=$C" '{"status":"inactive"}')" "403"
assert_eq "…nobody was invited" "$(q "select count(*) from \"UserInvitation\" where \"companyId\"='$C'" 2>/dev/null || echo 0)" "0"

note "=== read-only mode: reading stays possible ==="
assert_eq "GET the users" "$(call 1 GET "/api/v1/users?companyId=$C")" "200"
assert_eq "GET the invoices" "$(call 1 GET "/api/v1/invoices?companyId=$C")" "200"
S=$(call 1 POST "/api/v1/invoices/bulk-download?companyId=$C" '{"invoiceIds":[]}')
assert_eq "POST bulk-download (a read by POST) is not refused as a write ($S)" "$([[ "$S" != 403 ]] && echo ok || echo "$S $(head -c 100 /tmp/t547.out)")" "ok"

note "=== without read-only mode the admin can ==="
assert_eq "PUT the Mahngebühren: 200" "$(call 0 PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"mahngebuehr":{"first":3}}')" "200"
assert_eq "PATCH the viewer to accountant: 200" "$(call 0 PATCH "/api/v1/users/$V/role?companyId=$C" '{"role":"accountant"}')" "200"

note "=== a re-verification is the company's own ==="
call 0 POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"vatId\":\"FR12345678901\"}" >/dev/null
assert_eq "reverify-now: 201" "$(call 0 POST "/api/v1/vat-validation/reverify-now?companyId=$C" '{}')" "201"
assert_eq "…it looked at this company's one customer (was every company's)" "$(python3 -c "import json;d=json.load(open('/tmp/t547.out'));print(d['customers'], d['suppliers'])")" "1 0"
rm -f /tmp/t547.out

summary
