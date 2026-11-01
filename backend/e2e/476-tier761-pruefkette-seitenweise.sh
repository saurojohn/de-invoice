#!/bin/bash
# Tier 761 — the audit chain is walked a page at a time
#
# verifyChain loaded every row of a company. At 300 000 rows that ended the
# process (JavaScript heap out of memory), for every user, on one click. It now
# reads 2 000 rows at a time: the walk has to get past the first page, and the
# count has to be the company's, not the page's.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t761-$(date +%s)"
BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier761-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])")
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
# Unsigned rows, as before Tier 196, do not break a chain; the one after them does.
q "insert into \"AuditLog\"(id,\"companyId\",action) select '$TAG-'||n,'$C','test.row' from generate_series(1,2500) n" >/dev/null
q "update \"AuditLog\" set hash='tampered', \"hashAlgorithm\"='SHA-256-V2' where id='$TAG-2300'" >/dev/null
RESP=$(curl -sS -m 60 -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/audit-logs/verify?companyId=$C")
field() { printf '%s' "$RESP" | python3 -c "import json,sys; r=json.load(sys.stdin); print(eval('r'+sys.argv[1]))" "$1"; }
ALL=$(q "select count(*) from \"AuditLog\" where \"companyId\"='$C'")
assert_eq "the row on the second page is found" "$(field "['brokenAt']['id']")" "$TAG-2300"
assert_eq "the reason" "$(field "['brokenAt']['reason']")" "hash_mismatch"
assert_eq "the count is the company's" "$(field "['totalRows']")" "$ALL"
q "update \"AuditLog\" set hash=null, \"hashAlgorithm\"=null where id='$TAG-2300'" >/dev/null
RESP=$(curl -sS -m 60 -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/audit-logs/verify?companyId=$C")
assert_eq "nothing wrong: the walk reaches the end" "$(field "['ok']")" "True"
assert_eq "and says how far" "$(field "['verifiedRows']")" "$ALL"
q "delete from \"AuditLog\" where \"companyId\"='$C'" >/dev/null
summary
