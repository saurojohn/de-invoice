#!/bin/bash
# Tier 729c — a template of the company's own, chosen per invoice
#
# Measured: the company's templates (Rechnungsvorlagen: colours, font,
# texts) could not be chosen for an invoice — only the default applied. The
# renderer read invoice.templateId, a column that did not exist; the form's
# „Rechnungsvorlage“ offered the three built-in layouts only.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-446-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
reg() { # → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier729c-e2e\",\"companyName\":\"$1 Werkstatt\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
read -r U2 C2 < <(reg "$TAG-b")
[[ -n "${C:-}" && -n "${C2:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
footer_of() { # invoice → which template's footer text the PDF carries
  curl -sS -o "$WORK/p.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$1/pdf?companyId=$C"
  local t; t=$(pdf_text "$WORK/p.pdf")
  if grep -q "Fusstext Haus" <<<"$t"; then echo Haus; elif grep -q "Fusstext Rot" <<<"$t"; then echo Rot; else echo none; fi
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","address":{"street":"Hauptstr. 5","postalCode":"10115","city":"Berlin","country":"DE"}}'
AS POST "/api/v1/invoice-templates?companyId=$C" "{\"companyId\":\"$C\",\"name\":\"Haus\",\"isDefault\":true,\"configJson\":{\"footerText\":\"Fusstext Haus\"}}"
HAUS=$(json_field "$BODY" id)
AS POST "/api/v1/invoice-templates?companyId=$C" "{\"companyId\":\"$C\",\"name\":\"Rot\",\"configJson\":{\"footerText\":\"Fusstext Rot\",\"primaryColor\":\"#aa0000\"}}"
ROT=$(json_field "$BODY" id)
curl -sS -X POST "$API/api/v1/invoice-templates?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$C2\",\"name\":\"Fremd\",\"configJson\":{}}" > "$WORK/f.json"
FREMD=$(json_field "$(cat "$WORK/f.json")" id)
[[ -n "$HAUS" && -n "$ROT" && -n "$FREMD" ]] && pass "fixture: a default „Haus“, a second „Rot“, another company's „Fremd“" || fail "templates"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
TODAY=$(TZ=Europe/Berlin date +%F)   # a draft can be changed on its issue day only
inv() { # [type] [templateId] → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"${1:-INV}\",\"issueDate\":\"$TODAY\",${2:+\"templateId\":\"$2\",}\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
}

note "=== 1. chosen per invoice ==="
inv INV "$ROT"
assert_eq "kept (there was no such column)" "$STATUS/$(json_field "$BODY" templateId)" "201/$ROT"
assert_eq "its PDF: the chosen template (was: the default)" "$(footer_of "$I")" "Rot"
inv INV
assert_eq "none chosen: the default" "$(footer_of "$I")" "Haus"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"templateId\":\"$ROT\"}"
assert_eq "changed on the draft" "$STATUS/$(footer_of "$I")" "200/Rot"
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"templateId":""}'
assert_eq "…back to the default" "$STATUS/$(json_field "$BODY" templateId)/$(footer_of "$I")" "200//Haus"

note "=== 2. only the company's own ==="
inv INV "$FREMD"
assert_eq "another company's template: 400" "$STATUS" "400"
inv INV "00000000-0000-0000-0000-000000000000"
assert_eq "an unknown one: 400" "$STATUS" "400"

note "=== 3. a template deleted later ==="
inv QU "$ROT"; QU=$I
AS DELETE "/api/v1/invoice-templates/$ROT?companyId=$C"
assert_eq "fixture: „Rot“ deleted" "$STATUS" "200"
assert_eq "the quote renders with the default" "$(footer_of "$QU")" "Haus"
AS POST "/api/v1/invoices/$QU/convert?companyId=$C" '{"to":"INV"}'
assert_eq "…and still converts to an invoice (with the default)" "$STATUS/$(json_field "$BODY" templateId)" "201/"

summary
