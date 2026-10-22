#!/bin/bash
# Tier 728d — invoice templates: the preview shows the company's own invoice
# with the template's settings; „Logo anzeigen“ is honoured
#
# Measured:
#   - the preview (POST /invoice-templates/:id/preview) rendered an invented
#     „Beispiel-Unternehmen GmbH“ without the template's settings — colours,
#     font, density, footer text, payment terms and logo were „recorded but
#     not yet visually applied“; a template could not be previewed before it
#     was saved;
#   - the template's „Logo anzeigen“ was read nowhere: off, the invoice still
#     carried the logo.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-441-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier728d-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Werkstatt Lederwaren GmbH\",\"vatId\":\"DE123456789\",\"registerEntry\":\"Amtsgericht Berlin-Charlottenburg, HRB 123456 B\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: the company's details" "$STATUS" "200"
# a logo (a small PNG made here)
python3 - "$WORK/logo.png" <<'PY'
import sys, zlib, struct
w, h = 60, 20
raw = b''.join(b'\x00' + bytes([120, 60, 20]) * w for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PY
UP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$WORK/logo.png;type=image/png" -F "companyId=$C" "$API/api/v1/companies/upload-logo")
assert_eq "fixture: a logo" "$UP" "201"
# the logo by its size (60 × 20) — the GiroCode is two image objects (picture and mask)
logos() { python3 -c "import sys,re;print(len(re.findall(rb'/Width 60\s*/Height 20\b', open(sys.argv[1],'rb').read())))" "$1"; }

note "=== 1. the preview of a template not yet saved ==="
curl -sS -o "$WORK/draft.pdf" -w "%{http_code}" -X POST -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  "$API/api/v1/invoice-templates/preview?companyId=$C" -d '{"name":"Probe","configJson":{"footerText":"Danke T441 fuer Ihren Auftrag","primaryColor":"#aa0000","showLogo":false}}' > "$WORK/code"
assert_eq "a PDF (there was no such route)" "$(cat "$WORK/code")/$(head -c 4 "$WORK/draft.pdf")" "200/%PDF"
T=$(pdf_text "$WORK/draft.pdf")
assert_eq "the company's own details (was „Beispiel-Unternehmen GmbH“)" \
  "$(echo "$T" | grep -c "$TAG Werkstatt Lederwaren GmbH")/$(echo "$T" | grep -c "Handelsregister: Amtsgericht Berlin-Charlottenburg")/$(echo "$T" | grep -c "Beispiel-Unternehmen")" "1/1/0"
assert_eq "the template's footer text (was: not applied)" "$(echo "$T" | grep -c "Danke T441 fuer Ihren Auftrag")" "1"
assert_eq "„Logo anzeigen“ off: no logo" "$(logos "$WORK/draft.pdf")" "0"
curl -sS -o /dev/null -w "%{http_code}" -X POST -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  "$API/api/v1/invoice-templates/preview?companyId=$C" -d '{"configJson":{"fontFamily":"Comic-Sans"}}' > "$WORK/code"
assert_eq "a setting the renderer has not: 400" "$(cat "$WORK/code")" "400"

note "=== 2. a saved template, the default — on a real invoice ==="
AS POST "/api/v1/invoice-templates?companyId=$C" "{\"companyId\":\"$C\",\"name\":\"Ohne Logo\",\"isDefault\":true,\"configJson\":{\"showLogo\":false,\"footerText\":\"Danke T441\"}}"
TPL=$(json_field "$BODY" id)
assert_eq "fixture: a default template without logo" "$STATUS" "201"
curl -sS -o "$WORK/saved.pdf" -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoice-templates/$TPL/preview?companyId=$C"
assert_eq "its preview: the company's name, no logo" "$(pdf_text "$WORK/saved.pdf" | grep -c "$TAG Werkstatt Lederwaren GmbH")/$(logos "$WORK/saved.pdf")" "1/0"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
curl -sS -o "$WORK/inv.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C"
assert_eq "the invoice under it: no logo (was: the logo all the same)" "$(logos "$WORK/inv.pdf")" "0"
AS PUT "/api/v1/invoice-templates/$TPL?companyId=$C" '{"configJson":{"showLogo":true,"footerText":"Danke T441"}}'
curl -sS -o "$WORK/inv2.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C"
assert_eq "…switched on: the logo" "$(logos "$WORK/inv2.pdf")" "1"

summary
