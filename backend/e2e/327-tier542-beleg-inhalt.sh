#!/bin/bash
# Tier 542 — an uploaded Beleg is the file it says it is
#
# Measured before: an HTML page uploaded as "beleg.pdf" was stored and served
# as application/pdf (only the extension was looked at); a file with a
# 400-character name was ENAMETOOLONG on disk → 500; an empty file was stored.
#
# Now the first bytes must fit the extension (PDF, PNG, JPEG, GIF, WebP, TIFF,
# Office formats; a .txt has no NUL), an empty file is refused, and a long
# name is shortened on disk while the record keeps the original.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-327-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier542-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
E=$(curl -sS -X POST "$API/api/v1/ustva/expenses?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"description\":\"$TAG\",\"invoiceDate\":\"2026-09-01\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
D=$(mktemp -d)
up() { # file mime name → status (body in $D/out)
  curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/attachments" -H "x-user-id: $U" -H "x-company-id: $C" \
    -F "companyId=$C" -F "entityType=expense" -F "entityId=$E" -F "file=@$1;type=$2;filename=$3"
}
count() { q "select count(*) from \"Attachment\" where \"companyId\"='$C'"; }
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$D/ok.pdf"
printf '<html><script>alert(1)</script></html>' > "$D/page.html"
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))" "$D/ok.png"
: > "$D/empty.pdf"
printf 'Notiz zum Beleg\n' > "$D/ok.txt"

note "=== the content fits the extension ==="
assert_eq "a PDF: stored" "$(up "$D/ok.pdf" application/pdf beleg.pdf)" "201"
assert_eq "a PNG: stored" "$(up "$D/ok.png" image/png scan.png)" "201"
assert_eq "a text note: stored" "$(up "$D/ok.txt" text/plain notiz.txt)" "201"
assert_eq "an HTML page named beleg.pdf: 400 (was 201)" "$(up "$D/page.html" application/pdf beleg.pdf)" "400"
assert_eq "…saying the content does not fit" "$(grep -c "passt nicht zu ihrer Endung" "$D/out")" "1"
assert_eq "a PDF named scan.png: 400 (was 201)" "$(up "$D/ok.pdf" image/png scan.png)" "400"
assert_eq "a PNG named beleg.pdf: 400 (was 201)" "$(up "$D/ok.png" application/pdf beleg.pdf)" "400"
assert_eq "an empty file: 400 (was 201)" "$(up "$D/empty.pdf" application/pdf leer.pdf)" "400"
assert_eq "…three stored, none of the others" "$(count)" "3"

note "=== a long name ==="
LONG="$(python3 -c "print('a'*400)").pdf"
assert_eq "400 characters: stored (was 500)" "$(up "$D/ok.pdf" application/pdf "$LONG")" "201"
assert_eq "…the record keeps the name it came with" "$(q "select length(\"originalName\") from \"Attachment\" where \"companyId\"='$C' order by \"createdAt\" desc limit 1")" "404"
assert_eq "…the file on disk has a short one, still a .pdf" "$(q "select length(split_part(\"storagePath\", '/', 5)) < 130 and \"storagePath\" like '%.pdf' from \"Attachment\" where \"companyId\"='$C' order by \"createdAt\" desc limit 1")" "t"
ID=$(python3 -c "import json;print(json.load(open('$D/out'))['id'])")
assert_eq "…and it downloads" "$(curl -s -o "$D/dl" -w '%{http_code}' "$API/api/v1/attachments/$ID/file?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")/$(head -c 5 "$D/dl")" "200/%PDF-"
rm -rf "$D"

summary
