#!/bin/bash
# Tier 934 — an invoice of time entries states when the hours were worked
#
# The open hours of a customer become an invoice draft (Tier 611). It had no
# Leistungsdatum: the PDF stated the day of the invoice (Tier 492) and the
# UStVA took it in that month (Tier 912). Measured: hours of the 10th and the
# 20th of last month, billed today — Leistungsdatum today, in this month's
# UStVA. § 14 Abs. 4 Nr. 6 UStG: the time of the supply — the entries' first
# to last day, or the one day.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-622-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
read -r LM10 LM20 < <(python3 -c "
import datetime as d
t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1)
print(t.replace(day=10).isoformat(), t.replace(day=20).isoformat())")
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier934-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 622","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
te() { AS POST "/api/v1/time-entries?companyId=$C" "{\"date\":\"$1\",\"minutes\":60,\"description\":\"Beratung\",\"customerId\":\"$K\",\"hourlyRate\":100}"; }
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }

note "=== hours of $LM10 and $LM20, billed today ==="
te "$LM10"; te "$LM20"
AS POST "/api/v1/time-entries/bill?companyId=$C" "{\"customerId\":\"$K\"}"
I=$(P "d['invoiceId']")
assert_eq "billed" "$STATUS" "201"
assert_eq "the invoice's Leistungszeitraum: the hours' first to last day (was none — today)" \
  "$(q "select coalesce(to_char(\"servicePeriodStart\",'YYYY-MM-DD'),'-')||'/'||coalesce(to_char(\"servicePeriodEnd\",'YYYY-MM-DD'),'-') from \"Invoice\" where id='$I'")" "$LM10/$LM20"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "issued" "$STATUS" "200"
assert_eq "UStVA: last month 200 (was 0), this month 0 (was 200)" "$(kz81 ${LM10:0:4} $((10#${LM10:5:2})))/$(kz81 $Y $M)" "200/0"

note "=== hours of one day ==="
te "$TODAY"
AS POST "/api/v1/time-entries/bill?companyId=$C" "{\"customerId\":\"$K\"}"
I=$(P "d['invoiceId']")
assert_eq "…its Leistungsdatum, no period" \
  "$(q "select coalesce(to_char(\"deliveryDate\",'YYYY-MM-DD'),'-')||'/'||coalesce(to_char(\"servicePeriodEnd\",'YYYY-MM-DD'),'-') from \"Invoice\" where id='$I'")" "$TODAY/-"

summary
