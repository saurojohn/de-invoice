#!/bin/bash
# Tier 745 — a Beleg taken off a record can be put back
#
# Tier 740 keeps a removed Beleg; the way back was a statement in the database.
# Now: GET /attachments/removed (who, when), the file with ?removed=1,
# POST /attachments/:id/restore. Closed periods stay as they are.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-465-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
register() { # suffix → "U C"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier745-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
read -r U C < <(register a)
read -r UB CB < <(register b)
[[ -n "${C:-}" && -n "${CB:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
expense() { # number date → id
  local body="{\"description\":\"Beleg\",\"invoiceDate\":\"$2\",\"invoiceNumber\":\"$1\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
  AS POST "/api/v1/expenses?companyId=$C" "$body"
  json_field "$BODY" id
}
attach() { # expenseId → attachment id
  printf '%%PDF-1.4 %s %s\n' "$TAG" "$1" > "$D/$1.pdf"
  curl -sS -X POST "$API/api/v1/attachments" -H "x-user-id: $U" -H "x-company-id: $C" \
    -F "file=@$D/$1.pdf;type=application/pdf" -F "companyId=$C" -F "entityType=expense" -F "entityId=$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"
}
E1=$(expense "$TAG-1" 2026-10-01); A1=$(attach "$E1")
E2=$(expense "$TAG-2" 2026-09-15); A2=$(attach "$E2")
E3=$(expense "$TAG-3" 2026-10-02); A3=$(attach "$E3")
LIST="/api/v1/attachments?companyId=$C&entityType=expense&entityId=$E1"
REMOVED="/api/v1/attachments/removed?companyId=$C&entityType=expense&entityId=$E1"

note "=== 1. what was taken off ==="
AS GET "$REMOVED"
assert_eq "nothing removed: an empty list" "$STATUS/$(P "len(d)")" "200/0"
AS DELETE "/api/v1/attachments/$A1?companyId=$C"
AS GET "$REMOVED"
assert_eq "the list names the file, the day and who" \
  "$(P "(len(d), d[0]['id'], d[0]['deletedBy'], d[0]['deletedAt'][:10] == '$(date -u +%Y-%m-%d)')")" "(1, '$A1', '$TAG-a@example.test', True)"
AS GET "/api/v1/attachments/$A1/file?companyId=$C"
assert_eq "the file does not open through the record" "$STATUS" "404"
assert_eq "…it does as a removed one, to look at" \
  "$(curl -sS -o "$D/out.pdf" -w '%{http_code}' "$API/api/v1/attachments/$A1/file?companyId=$C&removed=1" -H "x-user-id: $U" -H "x-company-id: $C")/$(cmp -s "$D/out.pdf" "$D/$E1.pdf" && echo same)" "200/same"
assert_eq "another company's removed list: empty" \
  "$(curl -sS "$API/api/v1/attachments/removed?companyId=$CB&entityType=expense&entityId=$E1" -H "x-user-id: $UB" -H "x-company-id: $CB")" "[]"
assert_eq "another company cannot open it" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/attachments/$A1/file?companyId=$CB&removed=1" -H "x-user-id: $UB" -H "x-company-id: $CB")" "404"
assert_eq "…nor restore it" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/attachments/$A1/restore?companyId=$CB" -H "x-user-id: $UB" -H "x-company-id: $CB")" "404"

note "=== 2. put back ==="
AS POST "/api/v1/attachments/$A1/restore?companyId=$C"
assert_eq "restored: 200" "$STATUS" "200"
AS GET "$LIST"
assert_eq "on the record again" "$(P "[a['id'] for a in d]")" "['$A1']"
AS GET "$REMOVED"
assert_eq "no longer in the removed list" "$(P "len(d)")" "0"
AS GET "/api/v1/attachments/$A1/file?companyId=$C"
assert_eq "it opens" "$STATUS" "200"
AS POST "/api/v1/attachments/$A1/restore?companyId=$C"
assert_eq "restoring what is not removed: 404" "$STATUS" "404"
assert_eq "the audit log has both steps" \
  "$(q "SELECT count(*) >= 2 FROM \"AuditLog\" WHERE \"entityId\"='$A1' AND \"companyId\"='$C';")" "t"
AS DELETE "/api/v1/attachments/$A1?companyId=$C"
assert_eq "it can be taken off again" "$STATUS" "200"

note "=== 3. closed periods stay as they are ==="
AS DELETE "/api/v1/attachments/$A2?companyId=$C"
assert_eq "fixture: the September Beleg taken off" "$STATUS" "200"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-09-30","reason":"Spec 465"}'
AS POST "/api/v1/attachments/$A2/restore?companyId=$C"
assert_eq "books closed: refused, says why" "$STATUS/$(P "'Wiederherstellen' in d['message']")" "400/True"
assert_eq "…still marked" "$(q "SELECT \"deletedAt\" IS NOT NULL FROM \"Attachment\" WHERE id='$A2';")" "t"

note "=== 4. a file that is gone ==="
AS DELETE "/api/v1/attachments/$A3?companyId=$C"
q "UPDATE \"Attachment\" SET \"storagePath\"='2026/10/attachments/$C/gibt-es-nicht.pdf' WHERE id='$A3';" >/dev/null
AS POST "/api/v1/attachments/$A3/restore?companyId=$C"
assert_eq "refused, says so; still marked" "$STATUS/$(P "'fehlt' in d['message']")/$(q "SELECT \"deletedAt\" IS NOT NULL FROM \"Attachment\" WHERE id='$A3';")" "400/True/t"

summary
