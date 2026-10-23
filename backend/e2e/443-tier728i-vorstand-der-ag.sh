#!/bin/bash
# Tier 728i — an AG names its Vorstand, not „Geschäftsführer“
#
# § 80 AktG: an AG's business letters name the members of the Vorstand (and
# the chair of the supervisory board); an AG has no Geschäftsführer. The
# invoice, the Mahnung, the statement, the e-mail signature and the
# e-invoice's BT-33 all printed „Geschäftsführer: …“ whatever the legal form.
# A KGaA names its persönlich haftende Gesellschafter (§ 278 AktG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-443-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier728i-e2e\",\"companyName\":\"$TAG Werke\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
lines() { pdf_text "$1" --lines | sed 's/\xc2\xa0/ /g'; }
DIR="Dr. Anna Beispiel (Vorsitzende), Bernd Muster; Aufsichtsratsvorsitzender: Carl Klein"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"name\":\"$TAG Werke\",\"legalName\":\"$TAG Werke AG\",\"rechtsform\":\"AG\",\"vatId\":\"DE123456789\",\"phone\":\"+49 30 1\",\"email\":\"info@werke.example.test\",\"registerEntry\":\"Amtsgericht München, HRB 98765\",\"managingDirector\":\"$DIR\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: an AG" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"contact\":{\"email\":\"k@example.test\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-07-01\",\"dueDate\":\"2026-07-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)

note "=== 1. the invoice ==="
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/inv.pdf" > /dev/null
L=$(lines "$WORK/inv.pdf")
assert_eq "„Vorstand: …“ (was „Geschäftsführer: …“)" \
  "$(echo "$L" | grep -cF "Vorstand: $DIR")/$(echo "$L" | grep -c 'Geschäftsführer')" "1/0"

note "=== 2. the e-invoice (BT-33) ==="
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x.xml" > /dev/null
assert_eq "BT-33 says „Vorstand:“" "$(grep -c "Vorstand: Dr. Anna Beispiel" "$WORK/x.xml")/$(grep -c 'Geschäftsführer' "$WORK/x.xml")" "1/0"

note "=== 3. the statement ==="
fetch "/api/v1/customers/$K/statement.pdf?companyId=$C&from=2026-06-01&to=2026-10-31" "$WORK/st.pdf" > /dev/null
L=$(lines "$WORK/st.pdf")
assert_eq "„Vorstand:“ in its footer" "$(echo "$L" | grep -c 'Vorstand: Dr. Anna Beispiel')/$(echo "$L" | grep -c 'Geschäftsführer')" "1/0"

note "=== 4. a KGaA ==="
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Werke KGaA\",\"rechtsform\":\"KGaA\",\"managingDirector\":\"$TAG Verwaltungs-AG\"}"
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/inv2.pdf" > /dev/null
assert_eq "„Persönlich haftende Gesellschafter: …“" "$(lines "$WORK/inv2.pdf" | grep -c "Persönlich haftende Gesellschafter: $TAG Verwaltungs-AG")" "1"

note "=== 5. a GmbH, as before ==="
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Werke GmbH\",\"rechtsform\":\"GmbH\",\"managingDirector\":\"Anna Beispiel\"}"
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/inv3.pdf" > /dev/null
assert_eq "„Geschäftsführer: …“" "$(lines "$WORK/inv3.pdf" | grep -c 'Geschäftsführer: Anna Beispiel')" "1"

summary
