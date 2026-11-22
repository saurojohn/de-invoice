#!/bin/bash
# Tier 926 — an issued invoice's supply moved into a submitted month
#
# An issued invoice may still be edited on its issue day. The lock of a
# submitted UStVA period (Tiers 537 / 914) looked at its dates before the edit
# only. Measured: last month submitted; an invoice of today (Leistungsdatum
# today) given a Leistungsdatum of last month — 200, and the submitted return
# changed under it (Kz 81 0 → 100).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-613-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
LM=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1);print(t.replace(day=10).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier926-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 613","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
lmKz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=${LM:0:4}&month=$((10#${LM:5:2}))"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }
AS GET "/api/v1/ustva/compute?companyId=$C&year=${LM:0:4}&month=$((10#${LM:5:2}))"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "the UStVA ${LM:0:7} is submitted" "$STATUS" "201"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "an invoice of today, issued" "$STATUS" "200"

AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"deliveryDate\":\"$LM\"}"
assert_eq "its Leistungsdatum moved to ${LM}: 400 (was 200)" "$STATUS" "400"
assert_eq "…and the submitted return is unchanged" "$(lmKz81)" "0"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"servicePeriodStart\":\"${LM:0:8}01\",\"servicePeriodEnd\":\"$LM\"}"
assert_eq "a Leistungszeitraum ending there: 400" "$STATUS" "400"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"deliveryDate\":\"$TODAY\",\"notes\":\"geändert\"}"
assert_eq "an edit within the open month: 200" "$STATUS" "200"

summary
