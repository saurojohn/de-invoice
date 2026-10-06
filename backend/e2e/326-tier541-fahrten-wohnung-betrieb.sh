#!/bin/bash
# Tier 541 — a company car's trips between home and the business
#
# The "not covered" of Tier 502. With the 1 % rule, the trips between home
# and the (first) business premises are not a business expense beyond the
# Entfernungspauschale (§ 4 Abs. 5 Satz 1 Nr. 6 EStG): per month 0,03 % of the
# list price per kilometre of the one-way distance, less 0,30 € per km for
# the first 20 km and 0,38 € from the 21st, per day with the trip. Measured
# before: the car had no distance (`commuteKm` → 400 "should not exist") and
# the profit no such add-back.
#
# List price 45 678 € (45 600), 25 km, 15 days a month:
#   0,03 % × 45 600 × 25 = 342,00   −   15 × (20 × 0,30 + 5 × 0,38) = 118,50
#   → 223,50 a month, added to the profit with the private use. No VAT.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-326-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier541-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
e4180() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"; P "[float(l['amount']) for l in d['einnahmen'] if l['kennziffer']=='4180']"; }
year() { AS GET "/api/v1/company-cars/private-use?companyId=$C&year=2025"; P "$1"; }

note "=== a car with 25 km to the business ==="
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-AB 123","listPrice":45678,"method":"one_percent","fromDate":"2025-01-01","commuteKm":25}'
assert_eq "recorded with its distance (was 400 — no such field)" "$STATUS" "201"
CAR=$(json_field "$BODY" id)
assert_eq "…15 days a month unless said otherwise" "$(P "(d['commuteKm'], d['commuteDays'])")" "(25, 15)"
assert_eq "the year: 12 × 223,50 = 2 682 € of trips, within 12 × 456 + 2 682 = 8 154 €" "$(year "(d['commute'], d['income'])")" "(2682, 8154)"
assert_eq "…a month: 223,50 of 679,50" "$(year "[(m['commute'], m['income']) for m in d['months'] if m['month']==3]")" "[(223.5, 679.5)]"
assert_eq "the EÜR adds it to the profit in 4180 (was 5 472)" "$(e4180)" "[8154.0]"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "Anlage G 2180 the same" "$(P "[float(l['amount']) for l in d['einnahmen'] if l['kennziffer']=='2180']")" "[8154.0]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=3"
assert_eq "the UStVA is unchanged — no VAT on the trips: 80 % of 456" "$(P "[(float(r['net']), float(r['vat'])) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9]")" "[(364.8, 69.31)]"

note "=== the Entfernungspauschale can be more than the 0,03 % ==="
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-E 1","listPrice":60000,"method":"electric_025","fromDate":"2025-01-01","commuteKm":10,"commuteDays":20}'
assert_eq "an electric car, 10 km, 20 days: recorded" "$STATUS" "201"
# 0,03 % × (60 000 × 0,25) × 10 = 45,00 − 20 × 3,00 = 60,00 → nothing to add
assert_eq "…45 € against 60 € of Pauschale: nothing added, never negative" "$(year "sorted(set(m['commute'] for m in d['months'] if m['carName']=='M-E 1'))")" "[0]"
assert_eq "…the year's trips stay 2 682 €" "$(year "d['commute']")" "2682"

note "=== changed later ==="
AS PUT "/api/v1/company-cars/$CAR?companyId=$C" '{"commuteKm":40}'
# 0,03 % × 45 600 × 40 = 547,20 − 15 × (6,00 + 20 × 0,38) = 204,00 → 343,20
assert_eq "moved 40 km away: 343,20 a month" "$STATUS/$(year "[m['commute'] for m in d['months'] if m['carName']=='M-AB 123' and m['month']==3]")" "200/[343.2]"
assert_eq "…the car is still in use (the edit did not end it)" "$(q "select \"untilDate\" is null from \"CompanyCar\" where id='$CAR'")" "t"
AS PUT "/api/v1/company-cars/$CAR?companyId=$C" '{"commuteKm":null}'
assert_eq "no trips any more: back to the private use alone" "$STATUS/$(e4180)" "200/[7272.0]"
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"X","listPrice":30000,"method":"one_percent","fromDate":"2025-01-01","commuteKm":0}'
assert_eq "0 km: 400" "$STATUS" "400"
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"X","listPrice":30000,"method":"one_percent","fromDate":"2025-01-01","commuteKm":2.5}'
assert_eq "2,5 km: 400 — whole kilometres" "$STATUS" "400"

summary
