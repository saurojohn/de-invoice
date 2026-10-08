#!/bin/bash
# Tier 589 — the activity log shows a company its own rows only
#
# GET /audit-logs/activity built its filter as
#   { OR: [{companyId}, {companyId: null}] }   and then   where.OR = <action prefixes>
# — the second assignment replaced the first, so the feed had no company
# filter at all. With ?actionPrefix= chosen by the caller, any user with
# audit.read read every company's audit rows, contents included (measured:
# 11 184 invoice rows of other companies; customers with address and VAT ID;
# logins with e-mail addresses). Found on the activity page, which showed
# another company's user. Rows without a company (manual cron runs, failed
# logins, the rows of the Company table) were shown to everyone by design;
# they are the operator's now — in the feed and in its CSV export.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-353-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier589-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
# how many of the returned rows belong to another company / to no company
foreign() { # → "<total> <other company> <no company>"
  local ids; ids=$(py 'print(",".join(chr(39)+r["id"]+chr(39) for r in d["rows"]))')
  local total; total=$(py 'print(d["total"])')
  if [[ -z "$ids" ]]; then echo "$total 0 0"; return; fi
  echo "$total $(q "select count(*) filter (where \"companyId\" is not null and \"companyId\" <> '$C') || ' ' || count(*) filter (where \"companyId\" is null) from \"AuditLog\" where id in ($ids)")"
}

company a; UA=$U; CA=$C
[[ -n "${CA:-}" ]] && pass "fixture: company A" || { fail "register"; summary; exit 1; }
fixture_issuer "$CA"
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Geheimkunde","type":"business","vatId":"DE136695976","address":{"street":"Verborgen 1","postalCode":"80331","city":"München","country":"DE"}}'
KA=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$KA'","issueDate":"'$TODAY'","items":[{"description":"Vertraulich","quantity":1,"unit":"Stk","unitPrice":4711,"vatRate":0.19}]}'
AS POST "/api/v1/system/errors/resolve-all?companyId=$C" '{}'
AS POST "/api/v1/system/errors/mute-all?companyId=$C" '{}'
assert_eq "fixture: A has customer, invoice and activity rows" "$(q "select count(*) > 3 from \"AuditLog\" where \"companyId\"='$CA'")" "t"

company b; UB=$U; CB=$C
note "=== 1. company B reads the activity feed ==="
AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500"
assert_eq "the default feed: nothing of another company, nothing without a company (was: every company's)" "$STATUS $(foreign | cut -d' ' -f2,3)" "200 0 0"
assert_eq "…A's user is not named in it" "$(echo "$BODY" | grep -c "$TAG-a@example.test")" "0"
for P in invoice. customer. c login company. error. cron. e; do
  AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500&actionPrefix=$P"
  assert_eq "actionPrefix=$P: nothing of another company, nothing without a company" "$STATUS $(foreign | cut -d' ' -f2,3)" "200 0 0"
done
AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500&actionPrefix=customer."
assert_eq "…A's customer is not in it (was: name, address and VAT ID)" "$(echo "$BODY" | grep -c "Geheimkunde")" "0"
AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500&actionPrefix=invoice."
assert_eq "…and B, who has no invoice, gets none (was: thousands)" "$(py 'print(d["total"])')" "0"

note "=== 2. B still sees its own ==="
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Eigener","type":"business","address":{"street":"a","postalCode":"1","city":"b","country":"DE"}}'
AS POST "/api/v1/system/errors/resolve-all?companyId=$C" '{}'
AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500&actionPrefix=customer."
assert_eq "its own customer row" "$(py 'print(d["total"], [r["action"] for r in d["rows"]])')" "1 ['customer.created']"
AS GET "/api/v1/audit-logs/activity?companyId=$C&take=500"
assert_eq "its own activity (error.resolve_all), by its own user" "$(py 'print([(r["action"], r["userEmail"]) for r in d["rows"]])')" "[('error.resolve_all', '$TAG-b@example.test')]"

note "=== 3. the CSV export ==="
csv() { curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/audit-logs/activity.csv?companyId=$C&days=365${1:+&actionPrefix=$1}"; }
assert_eq "default: B's one row, nothing of A" "$(csv | grep -c 'error\.')/$(csv | grep -c "$TAG-a@")" "1/0"
# Tier 597: B's own company row is B's now (it had no company before) — still none of anybody else
assert_eq "actionPrefix=company.: B's own company row, nobody else's (was: every company's master data)" "$(csv company. | grep -c 'company\.')/$(csv company. | grep -c "$TAG a GmbH")/$(csv company. | grep -c "$TAG b GmbH")" "1/0/1"
assert_eq "actionPrefix=login: no failed logins of others" "$(csv login | grep -c 'login_')" "0"
assert_eq "actionPrefix=customer.: its own customer only" "$(csv customer. | grep -c 'customer\.')/$(csv customer. | grep -c Geheimkunde)" "1/0"

note "=== 4. B cannot ask for A's feed ==="
AS GET "/api/v1/audit-logs/activity?companyId=$CA&take=10"
assert_eq "companyId of another company: refused" "$([[ "$STATUS" == "403" || "$STATUS" == "404" ]] && echo refused || echo "$STATUS")" "refused"
summary
