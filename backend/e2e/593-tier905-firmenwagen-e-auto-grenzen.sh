#!/bin/bash
# Tier 905 — 0,25 % / 0,5 % only where the law gives them
#
# Measured: a company car with a gross list price of 150 000 € was taken at
# 0,25 % — its private use a half of what § 6 Abs. 1 Nr. 4 Satz 2 Nr. 3 EStG
# gives (0,25 % only up to 60 000 € for a car acquired until 2023, 70 000 €
# from 1.1.2024 to 30.6.2025, 100 000 € since; above it 0,5 %); so was a car
# of 2017 at 0,5 % (the reduced rates are for cars acquired 2019 – 2030).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-593-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier905-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
car() { AS POST "/api/v1/company-cars?companyId=$C" "{\"name\":\"$1\",\"listPrice\":$2,\"method\":\"$3\",\"fromDate\":\"$4\"}"; }

car "E 150" 150000 electric_025 2025-09-01
assert_eq "150 000 € at 0,25 % (acquired 2025): refused (was: taken)" "$STATUS" "400"
assert_contains "…names the limit and the 0,5 %" "$BODY" "100.000 € bei einem am 1.9.2025 angeschafften Wagen"
car "E 95" 95000 electric_025 2025-09-01
assert_eq "95 000 € at 0,25 %, acquired after 30.6.2025: taken" "$STATUS" "201"
car "E 95 alt" 95000 electric_025 2025-03-01
assert_eq "95 000 € at 0,25 %, acquired in March 2025 (limit 70 000 €): refused" "$STATUS" "400"
car "E 65" 65000 electric_025 2023-05-01
assert_eq "65 000 € at 0,25 %, acquired 2023 (limit 60 000 €): refused" "$STATUS" "400"
car "E 65 b" 65000 electric_025 2024-05-01
assert_eq "65 000 € at 0,25 %, acquired 2024 (limit 70 000 €): taken" "$STATUS" "201"
car "E 150 halb" 150000 electric_05 2025-09-01
assert_eq "150 000 € at 0,5 %: taken" "$STATUS" "201"
car "Hybrid 2017" 50000 electric_05 2017-06-01
assert_eq "a car of 2017 at 0,5 %: refused (the reduced rates start with 2019)" "$STATUS" "400"
assert_contains "…says so" "$BODY" "2019 bis 2030"
car "Diesel" 150000 one_percent 2017-06-01
assert_eq "1 % at any price and date: taken" "$STATUS" "201"

summary
