#!/bin/bash
# Tier 384 — audit rows name the request's own user and company under concurrency
#
# The audit context was a process global. Measured before the change, two fresh
# tenants each sending 40 concurrent customer updates:
#   company A's customer: 42 audit rows — 15 with company A, 8 with company B
#                         (and B's user), 19 with no company
#   B's GET /audit-logs:  18 rows, 8 of them A's customer (name in newData)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-184-$(date +%s%N | cut -c1-13)"
N=40
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }

tenant() { # name → "userId companyId"
  curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier384-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA CA < <(tenant a)
read -r UB CB < <(tenant b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "two tenants" || { fail "register failed"; summary; exit 1; }
customer() { # user company label
  curl -s -X POST "$API/api/v1/customers?companyId=$2" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" -d "{\"name\":\"$TAG $3\",\"type\":\"business\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null
}
KA=$(customer "$UA" "$CA" A); KB=$(customer "$UB" "$CB" B)
[[ -n "$KA" && -n "$KB" ]] && pass "one customer each" || { fail "customer create failed"; summary; exit 1; }

note "=== 1. $N concurrent updates per tenant ==="
OUT=$(mktemp -d)
for i in $(seq 1 $N); do
  curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$API/api/v1/customers/$KA?companyId=$CA" -H "x-user-id: $UA" -H "x-company-id: $CA" \
    -H "Content-Type: application/json" -d "{\"name\":\"$TAG A $i\"}" >> "$OUT/a" &
  curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$API/api/v1/customers/$KB?companyId=$CB" -H "x-user-id: $UB" -H "x-company-id: $CB" \
    -H "Content-Type: application/json" -d "{\"name\":\"$TAG B $i\"}" >> "$OUT/b" &
done
wait
assert_eq "A: all updates 200" "$(grep -c '^200$' "$OUT/a")" "$N"
assert_eq "B: all updates 200" "$(grep -c '^200$' "$OUT/b")" "$N"

note "=== 2. every audit row carries its own request's user and company ==="
for t in "A $KA $CA $UA" "B $KB $CB $UB"; do
  read -r name k c u <<< "$t"
  assert_eq "$name: audit rows for its customer (create + $N updates)" "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\" = '$k';")" "$((N + 1))"
  assert_eq "$name: rows with another or no company (8 + 19 before)" "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\" = '$k' AND \"companyId\" IS DISTINCT FROM '$c';")" "0"
  assert_eq "$name: rows with another or no user" "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\" = '$k' AND \"userId\" IS DISTINCT FROM '$u';")" "0"
done
api_as() { curl -s "$API$1" -H "x-user-id: $2" -H "x-company-id: $3"; }
FOREIGN=$(api_as "/api/v1/audit-logs?companyId=$CB&take=200" "$UB" "$CB" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for r in d['rows'] if r.get('entityId')=='$KA'))" 2>/dev/null)
assert_eq "B's audit log lists none of A's customer rows (8 before)" "$FOREIGN" "0"

note "=== 3. the context survives a multipart upload under concurrency ==="
TMPD=$(mktemp -d)
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMPD/r.pdf"
for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST "$API/api/v1/attachments" -H "x-user-id: $UA" -H "x-company-id: $CA" \
    -F "file=@$TMPD/r.pdf;type=application/pdf" -F "companyId=$CA" -F entityType=berater-note -F "entityId=$TAG-$i" &
  curl -s -o /dev/null -X PUT "$API/api/v1/customers/$KB?companyId=$CB" -H "x-user-id: $UB" -H "x-company-id: $CB" \
    -H "Content-Type: application/json" -d "{\"name\":\"$TAG B up $i\"}" &
done
wait
ATT_IDS=$(sql "SELECT string_agg(id, ',') FROM \"Attachment\" WHERE \"companyId\" = '$CA';")
assert_eq "A: 10 attachments stored" "$(sql "SELECT count(*) FROM \"Attachment\" WHERE \"companyId\" = '$CA';")" "10"
assert_eq "…their audit rows name A and A's user" \
  "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityType\" = 'Attachment' AND \"entityId\" = ANY(string_to_array('$ATT_IDS', ',')) AND \"companyId\" = '$CA' AND \"userId\" = '$UA';")" "10"

note "=== 4. cleanup ==="
rm -rf "$OUT" "$TMPD"

summary
exit $?
