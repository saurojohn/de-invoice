#!/bin/bash
# Tier 933 — an issuing recurring run respects a submitted UStVA period
#
# A recurring template that issues its invoices ('sent') wrote them without
# the lock of a submitted UStVA period — a manual issue is refused there
# (Tier 537 / 914). Measured: the current month submitted, the run issued an
# invoice into it (201). (The review's other point, a credit note of no
# invoice, cannot arise: the API refuses a credit note without its invoice.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-621-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2})); NY=$((Y + 1)); D=$((10#${TODAY:8:2}))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier933-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 621","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)

note "=== 1. an issuing recurring run into a submitted month ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "this month's UStVA submitted" "$STATUS" "201"
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$K\",\"name\":\"Wartung\",\"interval\":\"monthly\",\"dayOfMonth\":$(( D > 28 ? 28 : D )),\"startDate\":\"$TODAY\",\"invoiceStatus\":\"sent\",\"sendEmail\":false,\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":500,\"vatRate\":0.19}]}"
T=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the run: refused (was 201 — an invoice issued into the submitted month)" "$STATUS" "400"
assert_eq "…as a manual issue, naming the submitted period" "$(echo "$BODY" | grep -c "übermittelt")" "1"
assert_eq "…and nothing issued" "$(q "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$T'")" "0"

summary
