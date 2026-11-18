#!/bin/bash
# Tier 865 — a Berater's attachment is shown in place only when it is a PDF or a picture
#
# Tier 573 decided which stored files a browser may show in place: a PDF or a
# picture; everything else is a download. An XML file shown on the API's own
# origin can carry a stylesheet or XHTML with script, and that script runs
# with the session of whoever opened it. The attachments and the file store
# follow the rule (common/content-disposition.ts); the Berater's notes did
# not — measured on Tier 864: an XML a Berater attached came back to the
# company's owner as `Content-Disposition: inline`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-557-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
reg() { curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1@example.test\",\"password\":\"Tier865-e2e\",\"companyName\":\"$1 GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null; }
read -r U C < <(reg "$TAG")
read -r B _ < <(reg "$TAG-berater")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qc "insert into \"UserCompany\" (\"userId\",\"companyId\",role) values ('$B','$C','berater')" >/dev/null
H=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
K=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" "${H[@]}" -d '{"name":"Kunde 557","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
I=$(curl -sS -X POST "$API/api/v1/invoices?companyId=$C" "${H[@]}" -d "{\"customerId\":\"$K\",\"issueDate\":\"2026-11-18\",\"dueDate\":\"2026-12-31\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
[[ -n "$I" ]] && pass "fixture: a company, its Berater, an invoice" || { fail "fixture"; summary; exit 1; }

attach() { # file mime → note id
  curl -sS -X POST "$API/api/v1/berater/notes" -H "x-user-id: $B" -H "x-company-id: $C" \
    -F companyId="$C" -F entityType=invoice -F entityId="$I" -F "message=Bitte prüfen" -F "file=@$1;type=$2" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))"
}
disposition() { # note id [query] → the Content-Disposition kind
  curl -sS -D - -o /dev/null "$API/api/v1/berater/notes/$1/attachment?companyId=$C${2:-}" -H "x-user-id: $U" -H "x-company-id: $C" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="content-disposition"{split($2,a,";"); print a[1]}'
}
printf '<?xml version="1.0"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><x>557</x></Invoice>\n' > "$W/rechnung.xml"
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$W/beleg.pdf"
python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))" "$W/bild.png"

NX=$(attach "$W/rechnung.xml" application/xml)
NP=$(attach "$W/beleg.pdf" application/pdf)
NI=$(attach "$W/bild.png" image/png)
assert_eq "fixture: three notes with an attachment" "$([[ -n "$NX" && -n "$NP" && -n "$NI" ]] && echo yes)" "yes"
assert_eq "an XML: a download (was: inline)" "$(disposition "$NX")" "attachment"
assert_eq "a PDF and a picture: shown in place" "$(disposition "$NP") $(disposition "$NI")" "inline inline"
assert_eq "?download=1: a download" "$(disposition "$NP" '&download=1')" "attachment"
assert_eq "…and never sniffed" \
  "$(curl -sS -D - -o /dev/null "$API/api/v1/berater/notes/$NX/attachment?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" | tr -d '\r' | grep -ci '^x-content-type-options: nosniff')" "1"
summary
