#!/bin/bash
# Tier 508 — the E-Bilanz carries the taxes of the Bilanz / GuV
#
# Tier 506 put the Steuerrückstellung (3100), the VAT still owed (4600), a tax
# refund due (1800) and the income taxes (GuV position 14) into the Bilanz and
# GuV. Measured before: the E-Bilanz still sent them as placeholders (null) —
# its Jahresüberschuss was after taxes while position 14 was empty, and the
# Bilanz positions it listed no longer added up to its totals.
#
# Fixture as spec 292: a GmbH, 10 000 € profit and 1 900 € VAT in 2025 →
# income taxes 2 982,50.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-294-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier508-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-06-02\",\"items\":[{\"description\":\"Projekt\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'

AS GET "/api/v1/accounting/ebilanz?companyId=$C&year=2025"
el() { P "[(p['value'] if p['value'] is None else float(p['value'])) for p in d['positions'] if p['elementId']=='de-gcd:$1'][0]"; }
assert_eq "Steuern vom Einkommen und Ertrag 2 982,50 (was a placeholder)" "$(el is.tax.incomeTax)" "2982.5"
assert_eq "Steuerrückstellungen 2 982,50 (was a placeholder)" "$(el bs.liab.accr.taxProvisions)" "2982.5"
assert_eq "Sonstige Verbindlichkeiten: the VAT 1 900 (was a placeholder)" "$(el bs.liab.cred.othLiabRemaining)" "1900.0"
assert_eq "…the pension provisions stay the Berater's" "$(el bs.liab.accr.provisionsForPensions)" "None"
assert_eq "Jahresüberschuss 7 017,50 = 10 000 − 2 982,50 — the GuV adds up" \
  "$(P "round(sum(float(p['value'] or 0) for p in d['positions'] if p['elementId']=='de-gcd:is.netIncome' or p['source']=='guv.jahresueberschuss'), 2)")" "7017.5"
XML=$(curl -sS "$API/api/v1/accounting/ebilanz.xml?companyId=$C&year=2025" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "XML: the tax provision is a fact" "$(echo "$XML" | grep -c 'taxProvisions[^>]*>2982.5')" "1"

summary
