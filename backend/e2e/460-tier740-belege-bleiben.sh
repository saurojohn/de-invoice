#!/bin/bash
# Tier 740 — a Beleg stays
#
# Measured before (writing the Verfahrensdokumentation): DELETE
# /attachments/:id removed row and bytes of a Beleg, also in closed books, also
# the kept original of a received e-invoice; DELETE /storage/files/<path>
# (Einstellungen → Dateien) removed the kept copy of an issued invoice and the
# bytes under an attachment's row. § 146 Abs. 4, § 147 AO. Now:
#   1. taken off an open record, a Beleg is marked: the record no longer shows
#      it, row and bytes stay, the audit log has it;
#   2. in closed books it is refused;
#   3. the received e-invoice as it came cannot be taken off;
#   4. the storage route removes only what belongs to nothing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-460-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
register() { # suffix → "U C"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier740-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
read -r U C < <(register buyer)
read -r US CS < <(register seller)
[[ -n "${C:-}" && -n "${CS:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE136695976
fixture_issuer "$CS" DE811907980
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
expense() { # number date → id
  local body="{\"description\":\"Beleg\",\"invoiceDate\":\"$2\",\"invoiceNumber\":\"$1\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
  AS "$U" "$C" POST "/api/v1/expenses?companyId=$C" "$body"
  json_field "$BODY" id
}
attach() { # expenseId → attachment id
  printf '%%PDF-1.4 %s %s\n' "$TAG" "$1" > "$D/$1.pdf"
  curl -sS -X POST "$API/api/v1/attachments" -H "x-user-id: $U" -H "x-company-id: $C" \
    -F "file=@$D/$1.pdf;type=application/pdf" -F "companyId=$C" -F "entityType=expense" -F "entityId=$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"
}
bytes() { # storagePath → http status of the file
  curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/storage/files/${1//\//,}" -H "x-user-id: $U" -H "x-company-id: $C"
}

note "=== 1. off an open record: marked, not destroyed ==="
E1=$(expense "$TAG-1" 2026-10-01)
A1=$(attach "$E1")
PATH1=$(q "SELECT \"storagePath\" FROM \"Attachment\" WHERE id='$A1';")
AS "$U" "$C" DELETE "/api/v1/attachments/$A1?companyId=$C"
assert_eq "taken off: 200" "$STATUS" "200"
AS "$U" "$C" GET "/api/v1/attachments?companyId=$C&entityType=expense&entityId=$E1"
assert_eq "the record no longer shows it" "$(P "len(d)")" "0"
AS "$U" "$C" GET "/api/v1/attachments/$A1/file?companyId=$C"
assert_eq "…nor does it open through the record" "$STATUS" "404"
AS "$U" "$C" DELETE "/api/v1/attachments/$A1?companyId=$C"
assert_eq "…and it cannot be taken off twice" "$STATUS" "404"
assert_eq "the row stays, marked with who and when (was: gone)" \
  "$(q "SELECT \"deletedAt\" IS NOT NULL, \"deletedById\" FROM \"Attachment\" WHERE id='$A1';")" "t|$U"
assert_eq "the bytes stay" "$(bytes "$PATH1")" "200"
assert_eq "the audit log has it" "$(q "SELECT count(*) > 0 FROM \"AuditLog\" WHERE \"entityId\"='$A1';")" "t"

note "=== 2. closed books: refused ==="
E2=$(expense "$TAG-2" 2026-09-15)
A2=$(attach "$E2")
AS "$U" "$C" PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-09-30","reason":"Spec 460"}'
assert_eq "fixture: the books closed up to 30.09." "$STATUS" "200"
AS "$U" "$C" DELETE "/api/v1/attachments/$A2?companyId=$C"
assert_eq "the Beleg of a closed period: 400, says why (was: 200, gone)" "$STATUS/$(P "'Belegs' in d['message']")" "400/True"
assert_eq "…not marked" "$(q "SELECT \"deletedAt\" IS NULL FROM \"Attachment\" WHERE id='$A2';")" "t"
AS "$U" "$C" GET "/api/v1/attachments?companyId=$C&entityType=expense&entityId=$E2"
assert_eq "…still on the record" "$(P "len(d)")" "1"

note "=== 3. the received e-invoice as it came ==="
ISSUER='{"legalName":"Tier 740 Verkauf GmbH","registerEntry":"HRB 12345 Amtsgericht Berlin","email":"info@t740.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS "$US" "$CS" PUT "/api/v1/companies/$CS?companyId=$CS" "$ISSUER"
CUST="{\"name\":\"$TAG buyer GmbH\",\"type\":\"business\",\"vatId\":\"DE136695976\",\"contact\":{\"email\":\"einkauf@t740.example\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
AS "$US" "$CS" POST "/api/v1/customers?companyId=$CS" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"2026-10-10\",\"items\":[{\"description\":\"Beratung\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS "$US" "$CS" POST "/api/v1/invoices?companyId=$CS" "$INV"
I=$(json_field "$BODY" id)
AS "$US" "$CS" PUT "/api/v1/invoices/$I/status?companyId=$CS" '{"status":"sent"}'
curl -sS -o "$D/xr.xml" -H "x-user-id: $US" -H "x-company-id: $CS" "$API/api/v1/invoices/$I/xrechnung?companyId=$CS"
ST=$(curl -s -o "$D/out" -w '%{http_code}' -m 120 -X POST "$API/api/v1/expenses/e-invoice/import?companyId=$C" \
  -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$D/xr.xml")
assert_eq "fixture: imported" "$ST" "201"
EI=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['expenseIds'][0])" "$D/out")
AS "$U" "$C" GET "/api/v1/attachments?companyId=$C&entityType=expense&entityId=$EI"
AI=$(P "d[0]['id']")
assert_eq "the kept file is marked as the original" "$(P "d[0]['keptOriginal']")" "True"
AS "$U" "$C" DELETE "/api/v1/attachments/$AI?companyId=$C"
assert_eq "it cannot be taken off, on an open record too (was: 200, gone)" "$STATUS/$(P "'Original' in d['message']")" "400/True"
assert_eq "…row and mark as they were" "$(q "SELECT \"deletedAt\" IS NULL FROM \"Attachment\" WHERE id='$AI';")" "t"

note "=== 4. the storage route removes only what belongs to nothing ==="
curl -sS -o /dev/null "$API/api/v1/invoices/$I/pdf?companyId=$CS" -H "x-user-id: $US" -H "x-company-id: $CS"
KEPT=$(q "SELECT \"pdfPath\" FROM \"Invoice\" WHERE id='$I';")
[[ -n "$KEPT" ]] && pass "fixture: the issued invoice's kept copy" || fail "no kept copy"
AS "$US" "$CS" DELETE "/api/v1/storage/files/${KEPT//\//,}"
assert_eq "the kept copy of an issued invoice: 400 (was: 200, gone)" "$STATUS/$(P "'aufbewahrungspflichtig' in d['message']")" "400/True"
assert_eq "…still there" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/storage/files/${KEPT//\//,}" -H "x-user-id: $US" -H "x-company-id: $CS")" "200"
PATH2=$(q "SELECT \"storagePath\" FROM \"Attachment\" WHERE id='$A2';")
AS "$U" "$C" DELETE "/api/v1/storage/files/${PATH2//\//,}"
assert_eq "the file of an attachment: 400 (was: 200, the row left without bytes)" "$STATUS" "400"
assert_eq "the file of a Beleg taken off: 400 too — it is kept" "$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/api/v1/storage/files/${PATH1//\//,}" -H "x-user-id: $U" -H "x-company-id: $C")" "400"
printf '%%PDF-1.4 %s loose\n' "$TAG" > "$D/loose.pdf"
UPL=$(curl -sS -X POST "$API/api/v1/storage/upload" -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$D/loose.pdf")
LOOSE=$(json_field "$UPL" file.path)
AS "$U" "$C" DELETE "/api/v1/storage/files/${LOOSE//\//,}"
assert_eq "a file uploaded here that belongs to nothing: removed" "$STATUS" "200"

summary
