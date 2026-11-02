#!/bin/bash
# Tier 779 — the GoBD archive holds the audit trail, so it takes audit.read
#
# A sweep had a member of each role (viewer, accountant, auditor, Berater in
# read-only mode) call every route of their own company with its own ids and
# read the database after each call: no role wrote or read beyond its rank —
# except that GET /accounting/gobd-archive asked for accounting.read, and the
# ZIP holds Audit-Log.csv: every event of the trail with user, IP and the
# data before and after. A viewer may not read the trail (audit.read is the
# accountant's), and /audit-logs/export.csv refused them; the archive gave it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-484-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
reg() { # suffix → "user company"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier779-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA C < <(reg admin)
read -r UV _ < <(reg viewer)
read -r UB _ < <(reg accountant)
q "insert into \"UserCompany\" (\"userId\", \"companyId\", role) values ('$UV', '$C', 'viewer'), ('$UB', '$C', 'accountant')" >/dev/null
[[ -n "${C:-}" && -n "${UV:-}" && -n "${UB:-}" ]] && pass "fixture: a company with a viewer and an accountant" || { fail "register"; summary; exit 1; }
# something in the trail
curl -sS -o /dev/null -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $UA" -H "x-company-id: $C" \
  -H "Content-Type: application/json" -d "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"a 1\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"}}"
get() { # user path file → status
  curl -sS -o "$3" -w '%{http_code}' "$API$2" -H "x-user-id: $1" -H "x-company-id: $C"
}
trail() { python3 -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print('yes' if 'Audit-Log.csv' in z.namelist() and '$TAG' in z.read('Audit-Log.csv').decode() else 'no')" "$1" 2>/dev/null || echo "no zip"; }
Y=$(date +%Y)

note "=== the viewer ==="
assert_eq "the audit trail's own export: refused" "$(get "$UV" "/api/v1/audit-logs/export.csv?companyId=$C" "$D/v.csv")" "403"
assert_eq "the GoBD archive: refused too (was 200)" "$(get "$UV" "/api/v1/accounting/gobd-archive?companyId=$C&year=$Y" "$D/v.zip")" "403"
[[ "$(trail "$D/v.zip")" != "yes" ]] && pass "…so no Audit-Log.csv reaches the viewer (was in the ZIP)" || fail "the viewer got the trail"
assert_eq "…the message names the permission" "$(json_field "$(cat "$D/v.zip")" message)" "Unzureichende Berechtigung: audit.read"
assert_eq "the archive's summary on the page still loads" "$(get "$UV" "/api/v1/accounting/gobd-archive/summary?companyId=$C&year=$Y" "$D/s.json")" "200"

note "=== the accountant and the admin ==="
assert_eq "the accountant gets the archive" "$(get "$UB" "/api/v1/accounting/gobd-archive?companyId=$C&year=$Y" "$D/b.zip")" "200"
assert_eq "…with the trail in it" "$(trail "$D/b.zip")" "yes"
assert_eq "the admin gets it" "$(get "$UA" "/api/v1/accounting/gobd-archive?companyId=$C&year=$Y" "$D/a.zip")" "200"

summary
