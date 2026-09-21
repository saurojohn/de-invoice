#!/bin/bash
# Tier 419 — GuV and BWA count expenses at their net cost
#
# Both summed `grossAmount`, the supplier's price including VAT. For a business
# that deducts input tax the VAT comes back through the UStVA — it is not a
# cost. Measured: revenue 1 000 € and three expenses of 100 € net / 119 € gross
# → GuV Jahresüberschuss and BWA result 643 €, while EÜR said 700 €.
# A Kleinunternehmer (§ 19 UStG) cannot deduct input tax, so for them the
# gross amount is the cost.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
YEAR=2026

company() { # tag → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier419-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fixture() { # vatRate-of-sale
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde AG","type":"business"}'; local k; k=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$k\",\"issueDate\":\"$YEAR-08-10\",\"items\":[{\"description\":\"a\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":$1}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  for cat in Material Miete Sonstiges; do
    AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"$cat\",\"category\":\"$cat\",\"invoiceDate\":\"$YEAR-08-12\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
  done
}
guv() { AS GET "/api/v1/accounting/guv?companyId=$C&year=$YEAR"; python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['jahresueberschuss'])" "$BODY"; }
bwa() { AS GET "/api/v1/reports/bwa?companyId=$C&year=$YEAR&month=8"; python3 -c "import sys,json;t=json.loads(sys.argv[1])['totals'];print(t['materialaufwandMonat'], t['jahresergebnisYtd'])" "$BODY"; }
euer() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$YEAR"; python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['gewinn'])" "$BODY"; }

note "=== 1. a business that deducts input tax: expenses at net ==="
read -r U C < <(company "e2e-208a-$(date +%s%N | cut -c1-13)")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture 0.19
assert_eq "GuV Jahresüberschuss 700 (was 643)" "$(guv)" "700"
read -r MAT RES <<<"$(bwa)"
assert_eq "BWA Materialaufwand 100 (was 119)" "$MAT" "100"
assert_eq "BWA Jahresergebnis YTD 700 (was 643)" "$RES" "700"
assert_eq "EÜR Gewinn 700 — the three now agree" "$(euer)" "700"

note "=== 2. a Kleinunternehmer: expenses at gross ==="
read -r U C < <(company "e2e-208b-$(date +%s%N | cut -c1-13)")
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
assert_eq "company set to Kleinunternehmer" "$STATUS" "200"
fixture 0
assert_eq "GuV: 1000 − 3 × 119 = 643" "$(guv)" "643"
read -r MAT RES <<<"$(bwa)"
assert_eq "BWA Materialaufwand 119 (no input tax to deduct)" "$MAT" "119"
assert_eq "BWA Jahresergebnis 643" "$RES" "643"

summary; exit $?
