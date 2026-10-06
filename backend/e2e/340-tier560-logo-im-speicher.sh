#!/bin/bash
# Tier 560 — a company's logo is kept with the other uploaded files
#
# It was written to frontend/public/images/ beside the source tree. In the
# compose deployment that is a directory inside the BACKEND container: not a
# volume (every logo gone after the next deploy, and the invoice PDFs without
# it) and not the frontend container's public directory (the settings page and
# the invoice preview asked the frontend for /images/<name> and got 404).
# Now: <STORAGE_PATH>/_logos/, served by GET /companies/logo/:name.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-340-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
LOGOS="${STORAGE_PATH:-$HOME/data/invoice-system}/_logos"
OLD="$SCRIPT_DIR/../../frontend/public/images"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier560-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
D=$(mktemp -d)
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))" "$D/real.png"
get() { curl -s -o "$D/got" -D "$D/hdr" -w '%{http_code}' -m 20 "$API/api/v1/companies/logo/$1"; } # no auth headers: an <img> has none

assert_eq "upload a PNG" "$(curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/companies/upload-logo" -H "x-user-id: $U" -H "x-company-id: $C" -F "companyId=$C" -F "file=@$D/real.png;type=image/png;filename=logo.png")" "201"
NAME=$(q "select \"logoPath\" from \"Company\" where id='$C'")
assert_eq "the file is in the storage directory (was frontend/public/images)" "$([[ -f "$LOGOS/$NAME" ]] && echo yes || echo no)/$([[ -f "$OLD/$NAME" ]] && echo yes || echo no)" "yes/no"
assert_eq "GET /companies/logo/<name>: 200 without a login" "$(get "$NAME")" "200"
assert_eq "…as image/png, not to be sniffed" "$(tr -d '\r' < "$D/hdr" | grep -ic "^content-type: image/png\|^x-content-type-options: nosniff")" "2"
assert_eq "…the bytes that were uploaded" "$(cmp -s "$D/real.png" "$D/got" && echo same || echo differ)" "same"

note "=== only a logo is served ==="
echo secret > "$LOGOS/secret.png"
assert_eq "another file in the directory: 404" "$(get secret.png)" "404"
assert_eq "a path out of it: 404" "$(get "..%2F..%2F..%2Fetc%2Fhosts")" "404"
assert_eq "a logo that does not exist: 404" "$(get "logo-00000000-1700000000000.png")" "404"
rm -f "$LOGOS/secret.png"

note "=== a logo from before is still found ==="
LEGACY="logo-${C:0:8}-1700000000001.png"; mkdir -p "$OLD"; cp "$D/real.png" "$OLD/$LEGACY"
assert_eq "a file in the old directory: served" "$(get "$LEGACY")" "200"
rm -f "$OLD/$LEGACY"

note "=== replacing and removing ==="
assert_eq "upload again" "$(curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/companies/upload-logo" -H "x-user-id: $U" -H "x-company-id: $C" -F "companyId=$C" -F "file=@$D/real.png;type=image/png;filename=logo.png")" "201"
assert_eq "…the first file is gone" "$([[ -f "$LOGOS/$NAME" ]] && echo there || echo gone)/$(get "$NAME")" "gone/404"
NAME2=$(q "select \"logoPath\" from \"Company\" where id='$C'")
assert_eq "remove the logo" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/companies/remove-logo" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d '{}')" "201"
assert_eq "…file and record gone" "$([[ -f "$LOGOS/$NAME2" ]] && echo there || echo gone)/$(q "select coalesce(\"logoPath\",'-') from \"Company\" where id='$C'")" "gone/-"
rm -rf "$D"
summary
