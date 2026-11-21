#!/bin/bash
# Tier 906 — the Entfernungspauschale by year: 0,38 € from the first km since 2026
#
# Measured: the trips home – business of a company car (Tier 541) were set
# off against 0,30 € per km for the first 20 km and 0,38 € beyond — the
# amounts of 2022 – 2025 — in 2026 too. Since 2026 it is 0,38 € from the
# first km (§ 9 Abs. 1 Satz 3 Nr. 4 EStG, Steueränderungsgesetz 2025; the
# Anlage N has it since Tier 671). For 25 km on 15 days the month's
# addition to the profit was 223,50 € instead of 199,50 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-594-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier906-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
march() { AS GET "/api/v1/company-cars/private-use?companyId=$C&year=$1"; P "[m['commute'] for m in d['months'] if m['month']==3 and m['carName']=='$2']"; }

AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-AB 594","listPrice":45678,"method":"one_percent","fromDate":"2021-01-01","commuteKm":25}'
assert_eq "fixture: a car with 25 km to the business, 15 days a month" "$STATUS" "201"
# 0,03 % × 45 600 × 25 = 342,00 a month, less 15 days × the Pauschale
assert_eq "2026: 342 − 15 × 25 × 0,38 = 199,50 (was 223,50 at 0,30 / 0,38)" "$(march 2026 M-AB\ 594)" "[199.5]"
assert_eq "2025: 342 − 15 × (20 × 0,30 + 5 × 0,38) = 223,50 (unchanged)" "$(march 2025 M-AB\ 594)" "[223.5]"
assert_eq "2021: 342 − 15 × (20 × 0,30 + 5 × 0,35) = 225,75" "$(march 2021 M-AB\ 594)" "[225.75]"

AS POST "/api/v1/company-cars?companyId=$C" '{"name":"Nah 594","listPrice":45678,"method":"one_percent","fromDate":"2021-01-01","commuteKm":10}'
# 0,03 % × 45 600 × 10 = 136,80; 15 × 10 × 0,38 = 57,00 / × 0,30 = 45,00
assert_eq "10 km in 2026: 136,80 − 57,00 = 79,80 (was 91,80)" "$(march 2026 Nah\ 594)" "[79.8]"
assert_eq "10 km in 2025: 136,80 − 45,00 = 91,80" "$(march 2025 Nah\ 594)" "[91.8]"

summary
