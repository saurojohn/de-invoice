#!/bin/bash
# Tier 927 — a cash entry of a submitted month does not get a VAT rate
#
# A Kassenbuch entry without VAT may be booked into a submitted month (it is
# in no line of the UStVA — Tier 537). Changing it locked only an entry that
# already had a rate. Measured: last month submitted, a cash sale of last
# month without VAT given 19 % — 200, and the submitted return changed under
# it (Kz 81 0 → 100).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-614-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
LM=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1);print(t.replace(day=10).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier927-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
lmKz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=${LM:0:4}&month=$((10#${LM:5:2}))"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"${LM:0:8}01\",\"type\":\"eroeffnung\",\"description\":\"Anfangsbestand\",\"amount\":500}"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$LM\",\"type\":\"einnahme\",\"description\":\"Barverkauf\",\"amount\":119}"
E=$(json_field "$BODY" id)
assert_eq "a cash sale of $LM without VAT" "$STATUS" "201"
AS GET "/api/v1/ustva/compute?companyId=$C&year=${LM:0:4}&month=$((10#${LM:5:2}))"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "the UStVA ${LM:0:7} is submitted" "$STATUS" "201"

AS PUT "/api/v1/cashbook/entries/$E?companyId=$C" '{"vatRate":0.19}'
assert_eq "giving it 19 %: 400 (was 200)" "$STATUS" "400"
assert_eq "…and the submitted return is unchanged" "$(lmKz81)" "0"
AS PUT "/api/v1/cashbook/entries/$E?companyId=$C" '{"description":"Barverkauf Kiosk"}'
assert_eq "its text: 200, as before" "$STATUS" "200"

summary
