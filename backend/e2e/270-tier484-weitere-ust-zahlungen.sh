#!/bin/bash
# Tier 484 — VAT paid to / refunded by the Finanzamt outside a UStVA
#
# Tier 483 records a UStVA's payment on its filing; the annual return's
# Abschlusszahlung / Erstattung (UStJA) and the Sondervorauszahlung under
# Dauerfristverlängerung had no place (POST /ustva/payments 404), so the EÜR
# could not count them (Anlage EÜR Zeilen 18 / 58).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-270-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier484-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
line() { P "[l['amount'] for l in d['$1'] if l['kennziffer']=='$2'][0]"; }

AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"sondervorauszahlung","year":2026,"paidAt":"2026-02-10","amount":300,"note":"1/11 Vorjahr"}'
assert_eq "Sondervorauszahlung recorded (was 404)" "$STATUS" "201"
SV=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"ustja","year":2025,"paidAt":"2026-06-15","amount":-120,"note":"Erstattung laut Bescheid"}'
assert_eq "UStJA 2025 refund recorded" "$STATUS" "201"
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"zoll","year":2026,"paidAt":"2026-06-15","amount":5}'
assert_eq "an unknown kind is refused" "$STATUS" "400"
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"sonstige","year":2026,"paidAt":"2026-06-15","amount":0}'
assert_eq "…and an amount of 0" "$STATUS" "400"

AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: 5860 an das Finanzamt gezahlt 300" "$(line ausgaben 5860)" "300"
assert_eq "EÜR 2026: 4150 vom Finanzamt erstattet 120" "$(line einnahmen 4150)" "120"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "Anlage S: the same, in 4715 / 4140" "$(line ausgaben 4715)/$(line einnahmen 4140)" "300/120"

AS GET "/api/v1/ustva/payments?companyId=$C&year=2025"
assert_eq "listed by tax year" "$(P "[(p['kind'], float(p['amount'])) for p in d]")" "[('ustja', -120.0)]"
AS DELETE "/api/v1/ustva/payments/$SV?companyId=$C"
assert_eq "deleted" "$STATUS" "200"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "…and gone from the EÜR" "$(line ausgaben 5860)" "0"

summary
