#!/bin/bash
# Tier 940 — a gift over the 50 € limit: the input tax is corrected in the
# period the limit is passed, not in the months before
#
# The limit is judged per recipient over the year (Tier 503). The UStVA took
# that judgement into every period: a second gift in November that took the
# recipient over 50 € removed the input tax of his October gift — from
# October's return, submitted. Measured: Kz 66 October 7,60 € → 0.
# § 15 Abs. 1a UStG with § 17 Abs. 2 Nr. 5 UStG (UStAE 15.6 Abs. 5): the
# deduction is corrected in the period the limit is passed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-628-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
LM=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1);print(t.replace(day=10).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier940-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"euer","besteuerungsart":"soll"}'
gift() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Präsent\",\"category\":\"Geschenke\",\"giftRecipient\":\"Herr Kunde\",\"invoiceDate\":\"$1\",\"paidAt\":\"$1\",\"netAmount\":$2,\"vatRate\":0.19,\"vatAmount\":$3,\"grossAmount\":$4}"; }
vst() { AS GET "/api/v1/ustva/compute?companyId=$C&year=${1:0:4}&month=$((10#${1:5:2}))"; P "d['vorsteuer']['total']"; }
same_year=$([ "${LM:0:4}" = "$Y" ] && echo yes || echo no)
[ "$same_year" = yes ] || { note "January: last month is last year — the limit is a year's; nothing to test"; summary; exit 0; }

gift "$LM" 40 7.6 47.6
assert_eq "a gift of 40 € on $LM: its input tax 7,60 €" "$(vst "$LM")" "7.6"
AS GET "/api/v1/ustva/compute?companyId=$C&year=${LM:0:4}&month=$((10#${LM:5:2}))"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "…its month submitted" "$STATUS" "201"
gift "$TODAY" 20 3.8 23.8
assert_eq "a second gift of 20 € today — 60 € for the year, over the limit" "$STATUS" "201"
assert_eq "UStVA ${LM:0:7}: still 7,60 (was 0 — the submitted return changed)" "$(vst "$LM")" "7.6"
assert_eq "UStVA this month: −7,60, the earlier deduction taken back; none for today's gift" "$(vst "$TODAY")" "-7.6"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "the EÜR judges the year: both gifts not deductible (71,40 €)" "$(P "d['nichtAbziehbareGeschenke']")" "71.4"

summary
