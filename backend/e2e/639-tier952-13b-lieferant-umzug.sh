#!/bin/bash
# Tier 952 — a § 13b supplier's seat and the submitted returns
#
# The UStVA puts a § 13b bill under Kz 46 / 47 when its supplier sits in
# another EU country, else under Kz 84 / 85 — read from the supplier as it is
# now. Measured: an Irish supplier's hosting bill of October (1 000 €), October
# submitted, the supplier's address changed to the US: October's return showed
# Kz 84 / 85 instead of 46 / 47.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-639-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier952-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
kz() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=10"; P "sorted((k['kz'], float(k['value'])) for k in d['kennzahlen'] if k.get('value') and k['kz'] in ('46','47','84','85'))"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
supplier() { # name country → SUP
  AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$1\",\"address\":{\"street\":\"a\",\"city\":\"x\",\"postalCode\":\"1\",\"country\":\"$2\"}}"
  SUP=$(json_field "$BODY" id)
}
bill() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"description\":\"Hosting\",\"invoiceDate\":\"$1\",\"netAmount\":1000,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":1000,\"isReverseCharge\":true}"; }

supplier "Cloud Ltd" IE; IE=$SUP
bill 2026-10-05
assert_eq "October: the Irish supplier's § 13b bill under Kz 46 / 47" "$(kz)" "[('46', 1000.0), ('47', 190.0)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=10"
DATA=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$DATA"
assert_eq "October submitted" "$STATUS" "201"

AS PUT "/api/v1/suppliers/$IE?companyId=$C" '{"address":{"street":"a","city":"New York","postalCode":"10001","country":"US"}}'
assert_eq "the supplier moved to the US: refused (was 200)" "$STATUS/$(P "'neuen Lieferanten' in str(d.get('message'))")" "400/True"
assert_eq "…October unchanged (was Kz 84 / 85)" "$(kz)" "[('46', 1000.0), ('47', 190.0)]"
AS PUT "/api/v1/suppliers/$IE?companyId=$C" '{"address":{"street":"b","city":"Cork","postalCode":"T12","country":"IE"}}'
assert_eq "…a new address in the same country is fine" "$STATUS" "200"
AS PUT "/api/v1/suppliers/$IE?companyId=$C" '{"address":{"street":"b","city":"Paris","postalCode":"75001","country":"FR"}}'
assert_eq "…so is another EU country (the same line)" "$STATUS" "200"

supplier "Neu Inc" US
bill 2026-11-05
AS PUT "/api/v1/suppliers/$SUP?companyId=$C" '{"address":{"street":"a","city":"Dublin","postalCode":"D01","country":"IE"}}'
assert_eq "a supplier whose § 13b bills are in no submitted return may move" "$STATUS" "200"

summary
