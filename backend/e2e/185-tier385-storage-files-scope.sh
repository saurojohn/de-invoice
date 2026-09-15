#!/bin/bash
# Tier 385 — /storage/files is scoped to the caller's company; the storage root
# is not an API setting
#
# Measured before the change, as a freshly registered tenant B:
#   GET    /storage/files/<A's file>          → 200 with A's file
#   DELETE /storage/files/<A's file>          → 200, file deleted
#   GET    /storage/files/..,<root>-sibling,x → 200 (string-prefix path check)
#   POST   /storage/config {"localPath":"/"}  → 201, for every tenant; then
#   GET    /storage/files/etc,hosts           → 200 with the server's /etc/hosts
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-185-$(date +%s%N | cut -c1-13)"

tenant() {
  curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier385-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA CA < <(tenant a)
read -r UB CB < <(tenant b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "two tenants" || { fail "register failed"; summary; exit 1; }
req() { # A|B method path [curl args]
  local u="$UA" c="$CA" resp
  [[ "$1" == B ]] && { u="$UB"; c="$CB"; }
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $u" -H "x-company-id: $c" "${@:4}")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
TMPD=$(mktemp -d)
printf '%%PDF-1.4 %s company A\n' "$TAG" > "$TMPD/a.pdf"

note "=== 1. a company's own files still work ==="
req A POST /api/v1/storage/upload -F "file=@$TMPD/a.pdf"
assert_status 201 "A uploads"
P=$(json_field "$BODY" file.path)
FILE=${P//\//,}
req A GET "/api/v1/storage/files/$FILE"
assert_status 200 "A reads its file"
[[ "$BODY" == *"$TAG company A"* ]] && pass "…content" || fail "…content: ${BODY:0:80}"
req A GET "/api/v1/storage/list?companyId=$CA"
assert_status 200 "A lists its files"
URL=$(echo "$BODY" | python3 -c "import sys,json;print(next((f['url'] for f in json.load(sys.stdin) if f['path']=='$P'),''))")
req A GET "$URL"
assert_status 200 "…the list's url serves the file"

note "=== 2. another company can neither read nor delete it ==="
req B GET "/api/v1/storage/files/$FILE"
assert_status 404 "B reads A's file (was 200)"
req B DELETE "/api/v1/storage/files/$FILE"
assert_status 404 "B deletes A's file (was 200, deleted)"
req A GET "/api/v1/storage/files/$FILE"
assert_status 200 "…A's file is still there"

note "=== 3. no path outside the company's files ==="
req A GET /api/v1/storage/config
ROOT=$(json_field "$BODY" localPath)
SIB="$(basename "$ROOT")-e2e185"
mkdir -p "$ROOT/../$SIB" && echo "$TAG sibling" > "$ROOT/../$SIB/x.txt"
req B GET "/api/v1/storage/files/..,$SIB,x.txt"
assert_status 404 "../<root>-sibling/x.txt (was 200)"
req B GET "/api/v1/storage/files/..%2F$SIB%2Fx.txt"
assert_status 404 "…with encoded slashes"
req B GET "/api/v1/storage/files/$(dirname "$P" | tr / ,),..,..,..,..,..,$SIB,x.txt"
assert_status 404 "…via the company's own directory"
rm -rf "${ROOT:?}/../$SIB"

note "=== 4. the storage root is not an API setting ==="
req B POST /api/v1/storage/config -H "Content-Type: application/json" -d '{"localPath":"/"}'
assert_status 403 "localPath / (was 201 for every tenant)"
req B GET /api/v1/storage/files/etc,hosts
assert_status 404 "etc,hosts (was 200 with /etc/hosts)"
req A GET /api/v1/storage/config
assert_eq "…root unchanged" "$(json_field "$BODY" localPath)" "$ROOT"
# settings page save: the whole form, localPath unchanged
req A POST /api/v1/storage/config -H "Content-Type: application/json" -d "{\"localPath\":\"$ROOT\",\"cloudEnabled\":false,\"cloudProvider\":\"local\"}"
assert_status 201 "settings form save with the unchanged path"

note "=== 5. cleanup ==="
req A DELETE "/api/v1/storage/files/$FILE"
assert_status 200 "A deletes its own file"
req A GET "/api/v1/storage/files/$FILE"
assert_status 404 "…gone"
rm -rf "$TMPD"

summary
exit $?
