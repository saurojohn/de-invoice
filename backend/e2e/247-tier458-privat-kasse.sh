#!/bin/bash
# Tier 458 — Privateinlage / Privatentnahme in the Kassenbuch
#
# A Kassenbuch entry without a VAT rate is money that is no business income or
# expense: the owner puts cash into the till or takes it out (Tier 425 — the
# EÜR, UStVA, GuV leave it out). Measured before:
#   - DATEV exported nothing for it: 500 € put in and 200 € taken out moved
#     the Kassenbuch to 300 € and left DATEV's Kasse (1000) at 0.
#   - the Kassenbuch page offered no such entry — 19 %, 7 % or 0 % only — so
#     a withdrawal entered there at 0 % became a business expense (EÜR 5900),
#     a deposit tax-free revenue (EÜR 4170, UStVA "sonstige steuerfreie
#     Umsätze"); the Playwright spec covers the page.
# Now DATEV books "Kasse an Privateinlagen 1890" and "Privatentnahmen 1800 an
# Kasse" (SKR03; both in the per-company account map).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-247-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier458-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
entry() { # type amount vatRate(json) description
  AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"2026-05-04","type":"'$1'","description":"'"$4"'","amount":'$2',"vatRate":'$3'}'
  [[ "$STATUS" == 201 ]] || fail "entry $*: $STATUS $BODY"
}
entry einnahme 500 null "Privateinlage"
entry ausgabe 200 null "Privatentnahme"
entry einnahme 119 0.19 "Barverkauf"
AS GET "/api/v1/cashbook/balance?companyId=$C"
note "Kassenbuch: $(echo "$BODY" | head -c 200)"

curl -sS -o /tmp/t458.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-05-01&endDate=2026-05-31"
assert_eq "DATEV Kasse 1000: 500 − 200 + 119 = 419 (was 119: the private moves missing)" "$(datev_balance /tmp/t458.csv 1000)" "419.00"
assert_eq "…the deposit on Privateinlagen 1890" "$(datev_balance /tmp/t458.csv 1890)" "-500.00"
assert_eq "…the withdrawal on Privatentnahmen 1800" "$(datev_balance /tmp/t458.csv 1800)" "200.00"

note "=== no business income or expense (as before) ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR: only the cash sale" "$(py 'print("%g/%g" % (d["totals"]["einnahmenTotal"], d["totals"]["ausgabenTotal"]))')" "100/0"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=5"
assert_eq "UStVA: 19 % on the sale, nothing exempt" "$(py 'print(d["umsatzsteuer"], d["otherExempt"])')" "19 0"

note "=== the account map ==="
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"accounts":{"privateWithdrawal":"1810","privateDeposit":"1880"}}'
curl -sS -o /tmp/t458.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-05-01&endDate=2026-05-31"
assert_eq "the Berater's own private accounts are used" \
  "$(datev_balance /tmp/t458.csv 1810)/$(datev_balance /tmp/t458.csv 1880)" "200.00/-500.00"

summary
