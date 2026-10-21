#!/bin/bash
# Tier 726 — the invoice PDF writes an amount as a German invoice does
#
# „€ 1.000,00“, „Rabatt 10 %: € -100,00“, „Gesamtbetrag: € 1.071,00“ — the
# pages have written „1.071,00 €“ since Tier 704; the PDF the customer gets
# put the sign first. Now „1.071,00 €“ there too (another currency was already
# „1.190,00 USD“). The customer statement likewise (the Mahnung already did).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-437-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier726-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"dueDate\":\"2026-10-31\",\"discountPercent\":10,\"items\":[{\"description\":\"Beratung\",\"quantity\":10,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
curl -sS -o "$WORK/inv.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C"
TXT=$(pdf_text "$WORK/inv.pdf" | sed 's/\xc2\xa0/ /g')
for want in "Gesamtbetrag: 1.071,00 €" "Nettobetrag: 900,00 €" "USt 19 %: 171,00 €" "Rabatt 10 %: -100,00 €" "100,00 €"; do
  echo "$TXT" | grep -qF "$want" && pass "„$want“" || fail "„$want“ not in the PDF: $(echo "$TXT" | grep -o 'Gesamtbetrag[^G]*' | head -1)"
done
LINES=$(pdf_text "$WORK/inv.pdf" --lines | sed 's/\xc2\xa0/ /g')
assert_eq "every amount ends in „€“, none starts with it (was „€ 1.071,00“)" \
  "$(echo "$LINES" | grep -cE '^€ ')/$(echo "$LINES" | grep -cE '^-?[0-9.]+,[0-9]{2} €$')" "0/7"

curl -sS -o "$WORK/st.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/customers/$K/statement.pdf?companyId=$C&from=2026-10-01&to=2026-10-31"
ST=$(pdf_text "$WORK/st.pdf" --lines | sed 's/\xc2\xa0/ /g')
assert_eq "the statement: 1.071,00 €, nothing with the sign first (was „€ 1.071,00“)" \
  "$(echo "$ST" | grep -c '1.071,00 €' | sed 's/^[1-9][0-9]*$/yes/')/$(echo "$ST" | grep -cE '€ -?[0-9]')" "yes/0"

summary
