#!/bin/bash
# Tier 453 — a stored file's URL opens it
#
# Measured before:
#   - POST /storage/upload answered with url "/api/v1/storage/<path>" — no such
#     route: GET on it was 404. The file route is files/*splat with the path's
#     slashes as commas, which is what GET /storage/list returned.
#   - the settings page's "Download" navigated to that list URL without the
#     auth headers: 401 (left open since Tier 385).
# Now both routes build the URL with one helper (storageFileUrl), and the page
# fetches the file with the headers (apiGetBlob) — its Playwright spec covers
# that side.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-242-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier453-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
F=/tmp/t453-$TAG.pdf
printf '%%PDF-1.4\n%% %s\n%%%%EOF\n' "$TAG" > "$F"

UP=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$F" "$API/api/v1/storage/upload?companyId=$C")
URL=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['file']['url'])")
[[ -n "$URL" ]] && pass "uploaded" || fail "upload: $UP"

CODE=$(curl -sS -o /tmp/t453-back.pdf -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$URL?companyId=$C")
assert_eq "the upload's url opens the file (was 404)" "$CODE" "200"
assert_eq "…the same bytes" "$(cmp -s "$F" /tmp/t453-back.pdf && echo same || echo differ)" "same"
LIST=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/storage/list?companyId=$C" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get('files',d);print(d[0]['url'])")
assert_eq "list and upload give the same url" "$LIST" "$URL"
assert_eq "without the auth headers it stays closed" "$(curl -sS -o /dev/null -w "%{http_code}" "$API$URL")" "401"

read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier453-e2e\",\"companyName\":\"$TAG B\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
assert_eq "another company cannot read it (Tier 385)" \
  "$(curl -sS -o /dev/null -w "%{http_code}" -H "x-user-id: $U2" -H "x-company-id: $C2" "$API$URL?companyId=$C2")" "404"

summary
