#!/bin/bash
# Tier 956 — a company car and the submitted months
#
# The private use of a company car is in each month's UStVA (an unpaid supply,
# § 3 Abs. 9a Nr. 1 UStG) and in its year's EÜR. A car could be entered from
# a submitted month on, ended earlier or later across submitted months, and
# deleted — each changed returns already sent and closed books.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-643-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier956-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (EÜR)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
month() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"; P "round(sum(float(k['value']) for k in d['kennzahlen'] if k['kz'] in ('81','86') and k.get('value')), 2)"; }
submit() {
  AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"
  local data; data=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
  AS POST "/api/v1/ustva/filings?companyId=$C" "$data"
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'

AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-AB 1","listPrice":40000,"method":"one_percent","fromDate":"2026-08-01"}'
CAR=$(json_field "$BODY" id)
assert_eq "a car used privately from August" "$STATUS" "201"
SEPT=$(month 9)
assert_eq "…September's return holds its private use" "$(python3 -c "print(float('$SEPT') > 0)")" "True"
submit 9
assert_eq "September submitted" "$STATUS" "201"

AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-AB 2","listPrice":30000,"method":"one_percent","fromDate":"2026-09-01"}'
assert_eq "a second car from September: refused (was 201 — September's return changed)" "$STATUS/$(P "'09/2026' in str(d.get('message')) or 'September' in str(d.get('message')) or 'Voranmeldung' in str(d.get('message'))")" "400/True"
AS PUT "/api/v1/company-cars/$CAR?companyId=$C" '{"untilDate":"2026-08-31"}'
assert_eq "the car ended on 31.08. (September out): refused (was 200)" "$STATUS" "400"
AS DELETE "/api/v1/company-cars/$CAR?companyId=$C"
assert_eq "the car deleted: refused (was 200)" "$STATUS" "400"
assert_eq "September unchanged" "$(month 9)" "$SEPT"
AS PUT "/api/v1/company-cars/$CAR?companyId=$C" '{"untilDate":"2026-10-31"}'
assert_eq "ended on 31.10. (September stays): taken" "$STATUS" "200"

summary
