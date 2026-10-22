#!/bin/bash
# Tier 728 — the company's details on the invoice
#
# The owner, 22.10.2026: „发票公司打印界面后台信息输入功能是否完善？“ Measured with
# every field of the settings filled in, on an invoice without a logo:
#   - the full name as registered („… Lederwaren GmbH“) stood nowhere — the
#     PDF printed only the short name (§ 14 Abs. 4 Nr. 1 UStG: the full name;
#     § 35a GmbHG: the legal form); the settings labelled that field
#     „Rechtsform“, so „GmbH“ typed there became the XRechnung's seller name;
#   - phone, fax, e-mail, website were printed only in the layout with a logo;
#   - a registered company's seat was not stated (§ 35a GmbHG);
#   - „DE“ under both addresses of a German letter to a German customer.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-439-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier728-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }

note "=== 1. the settings ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"legalName":"GmbH"}'
assert_eq "a legal form alone is no full name: 400, and why" "$STATUS/$(P "'Rechtsform, kein Firmenname' in str(d['message'])")" "400/True"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"name\":\"$TAG Werkstatt\",\"legalName\":\"$TAG Werkstatt Lederwaren GmbH\",\"rechtsform\":\"GmbH\",\"vatId\":\"DE123456789\",\"taxId\":\"12/345/67890\",\"phone\":\"+49 30 1234567\",\"fax\":\"+49 30 1234568\",\"email\":\"info@werkstatt.example.test\",\"website\":\"www.werkstatt.example.test\",\"registerEntry\":\"Amtsgericht Berlin-Charlottenburg, HRB 123456 B\",\"managingDirector\":\"Anna Beispiel, Bernd Muster\",\"otherInfo\":\"WEEE-Reg.-Nr. DE 12345678\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "every field saved" "$STATUS" "200"

pdf() { # customer country → $WORK/<country>.pdf lines in LINES
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde $1\",\"type\":\"business\",\"vatId\":\"$2\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"$3\",\"city\":\"$4\",\"country\":\"$1\"}}"
  local K; K=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Ledertasche\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local I; I=$(json_field "$BODY" id)
  curl -sS -o "$WORK/$1.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C"
  LINES=$(pdf_text "$WORK/$1.pdf" --lines | sed 's/\xc2\xa0/ /g')
}
has() { echo "$LINES" | grep -qxF "$1" && echo yes || echo no; }

note "=== 2. a German customer ==="
pdf DE "" 80331 München
assert_eq "the full legal name (was: nowhere)" "$(has "$TAG Werkstatt Lederwaren GmbH")" "yes"
assert_eq "the seat, from the address (was: not stated)" "$(has "Sitz der Gesellschaft: Berlin")" "yes"
assert_eq "register, directors, other details as before" \
  "$(has "Handelsregister: Amtsgericht Berlin-Charlottenburg, HRB 123456 B")/$(has "Geschäftsführer: Anna Beispiel, Bernd Muster")/$(has "WEEE-Reg.-Nr. DE 12345678")" "yes/yes/yes"
assert_eq "without a logo: phone · fax, e-mail, website (was: none of them)" \
  "$(has "Tel.: +49 30 1234567 · Fax: +49 30 1234568")/$(has "info@werkstatt.example.test")/$(has "www.werkstatt.example.test")" "yes/yes/yes"
assert_eq "no country line in a domestic letter (was: „DE“ twice)" "$(echo "$LINES" | grep -cxE 'DE|DEUTSCHLAND')" "0"
assert_eq "one page" "$(echo "$LINES" | grep -c '^Seite 1 von 1$')" "1"

note "=== 3. a customer in Austria ==="
pdf AT ATU12345678 1010 Wien
assert_eq "the countries in full, in capitals (DIN 5008)" "$(has "ÖSTERREICH")/$(has "DEUTSCHLAND")" "yes/yes"
assert_eq "…and the sender line names Germany" "$(echo "$LINES" | grep -c "· 10115 Berlin · DEUTSCHLAND$")" "1"

note "=== 4. the seat named in the other details is not repeated ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"otherInfo":"Sitz der Gesellschaft: Potsdam"}'
pdf DE "" 80331 München
assert_eq "„Sitz“ once, as written there" "$(echo "$LINES" | grep -c '^Sitz der Gesellschaft')/$(has "Sitz der Gesellschaft: Potsdam")" "1/yes"

summary
