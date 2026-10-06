#!/bin/bash
# Tier 543 — a logo is an image, whatever its name says
#
# `POST /companies/upload-logo` checked the declared type (image/png) and took
# the extension from the file's name. Measured before: "x.html", declared as
# image/png, was written as logo-<id>-<time>.html into the frontend's public
# directory — a page with a script, served from the app's own origin (stored
# XSS for anyone with the link), and stored as the company's logo.
#
# Now the extension comes from the file's first bytes; only a real PNG, JPEG,
# GIF or WebP is accepted.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-328-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
IMAGES="${STORAGE_PATH:-$HOME/data/invoice-system}/_logos" # Tier 560: with the uploaded files, not in the frontend tree

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier543-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
D=$(mktemp -d)
up() { # file declared-type name → status (body in $D/out)
  curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/companies/upload-logo" -H "x-user-id: $U" -H "x-company-id: $C" \
    -F "companyId=$C" -F "file=@$1;type=$2;filename=$3"
}
logo() { q "select coalesce(\"logoPath\",'') from \"Company\" where id='$C'"; }
mine() { ls "$IMAGES" 2>/dev/null | grep -c "^logo-${C:0:8}-.*$1\$" || true; }
printf '<html><script>document.title="x"</script></html>' > "$D/page.html"
printf '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>' > "$D/x.svg"
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))" "$D/real.png"

note "=== not an image ==="
assert_eq "x.html declared as image/png: 400 (was 201)" "$(up "$D/page.html" image/png x.html)" "400"
assert_eq "…no .html in the public directory (was written there)" "$(mine '\.html')" "0"
assert_eq "…no logo stored" "$(logo)" ""
assert_eq "the same content named logo.png: 400 (was 201)" "$(up "$D/page.html" image/png logo.png)" "400"
assert_eq "an SVG declared as image/png: 400 (was 201, as .svg)" "$(up "$D/x.svg" image/png logo.svg)" "400"
assert_eq "…nothing of this company on disk" "$(mine '')" "0"

note "=== an image ==="
assert_eq "a PNG: stored" "$(up "$D/real.png" image/png logo.png)" "201"
assert_eq "…as the company's logo, a .png" "$([[ "$(logo)" == logo-${C:0:8}-*.png ]] && echo ok || echo "$(logo)")" "ok"
assert_eq "a PNG named evil.html: stored — as .png (was .html)" "$(up "$D/real.png" image/png evil.html)/$([[ "$(logo)" == *.png ]] && echo png || echo "$(logo)")" "201/png"
assert_eq "…still no .html on disk" "$(mine '\.html')" "0"
# leave no file behind
curl -s -o /dev/null -X POST "$API/api/v1/companies/remove-logo" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "{\"companyId\":\"$C\"}"
rm -f "$IMAGES"/logo-${C:0:8}-*.png 2>/dev/null
rm -rf "$D"

summary
