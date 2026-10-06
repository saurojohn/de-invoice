#!/bin/bash
# Tier 544 — a logo path is a file name of the company's own, not a path
#
# `Company.logoPath` can be set with PUT /companies/:id, and the invoice PDF
# opened it as it came: an absolute path was used directly. Measured before:
# logoPath "/tmp/<file>.png" → 200, and the company's invoice PDF carried
# that image — any image the server can read, e.g. another tenant's uploaded
# receipt scan or logo.
#
# Now logoPath is a bare image file name (what the logo upload returns), not
# another company's upload, and the PDF only ever opens
# frontend/public/images/<name>.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-329-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
IMAGES="${STORAGE_PATH:-$HOME/data/invoice-system}/_logos" # Tier 560: with the uploaded files, not in the frontend tree
company() {
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier544-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
D=$(mktemp -d)
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))" "$D/secret.png"
upload() { curl -s -X POST "$API/api/v1/companies/upload-logo" -H "x-user-id: $U" -H "x-company-id: $C" -F "companyId=$C" -F "file=@$D/secret.png;type=image/png;filename=logo.png" | python3 -c "import sys,json;print(json.load(sys.stdin).get('logoPath',''))"; }
images_in_pdf() { # invoice id → number of image objects in its PDF
  curl -s -o "$D/inv.pdf" "$API/api/v1/invoices/$1/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
  grep -a -c "/Subtype /Image" "$D/inv.pdf" || true
}
logo() { q "select coalesce(\"logoPath\",'') from \"Company\" where id='$C'"; }

company B; UB=$U; CB=$C
LOGO_B=$(upload)
[[ "$LOGO_B" == logo-${CB:0:8}-*.png ]] && pass "fixture: company B has uploaded its logo" || fail "upload B: $LOGO_B"
company A
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
assert_eq "fixture: A's invoice PDF has no image" "$(images_in_pdf "$I")" "0"

note "=== a path is refused ==="
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"logoPath\":\"$D/secret.png\"}"
assert_eq "an absolute path: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"logoPath":"../../../../etc/x.png"}'
assert_eq "a path with ..: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"logoPath":"images/sub/x.png"}'
assert_eq "a path with a directory: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"logoPath":"x.html"}'
assert_eq "not an image name: 400 (was 200)" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"logoPath\":\"$LOGO_B\"}"
assert_eq "company B's uploaded logo: 400 (was 200)" "$STATUS" "400"
assert_eq "…A has no logo" "$(logo)" ""

note "=== a row from before with a path: the PDF does not open it ==="
q "update \"Company\" set \"logoPath\"='$D/secret.png' where id='$C'" >/dev/null
assert_eq "logoPath is an absolute path in the row: no image in the PDF (was 1)" "$(images_in_pdf "$I")" "0"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"logoPath\":\"$D/secret.png\",\"phone\":\"030 1\"}"
assert_eq "…the settings form can still be saved with the unchanged value" "$STATUS" "200"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"logoPath":""}'
assert_eq "…and the value cleared" "$STATUS/$(logo)" "200/"

note "=== the company's own upload ==="
LOGO_A=$(upload)
assert_eq "A uploads its logo" "$([[ "$LOGO_A" == logo-${C:0:8}-*.png ]] && echo ok || echo "$LOGO_A")" "ok"
assert_eq "…it is in the PDF" "$(images_in_pdf "$I")" "1"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"logoPath\":\"$LOGO_A\",\"phone\":\"030 2\"}"
assert_eq "…and the settings form saves with it" "$STATUS" "200"
rm -f "$IMAGES/$LOGO_A" "$IMAGES/$LOGO_B"; rm -rf "$D"

summary
