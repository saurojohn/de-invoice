#!/bin/bash
# Tier 914 — an igL at its invoice, at the latest for the month after the
# delivery; the lock of a submitted period by the day of the supply
#
# 1. § 13 Abs. 1 Nr. 6, § 18b Satz 2, § 18a Abs. 8 UStG: the tax period of an
#    innergemeinschaftliche Lieferung is the one of its invoice, but at the
#    latest the month after the delivery. Measured: delivered 10.09., invoiced
#    22.11. — Kz 41 and the ZM line in November; the law puts it in October.
# 2. Since Tier 912 the UStVA assigns an invoice by its supply; the lock of a
#    submitted period (Tier 537) read the issue date only. Measured: last
#    month submitted, an invoice for a supply of last month issued today —
#    accepted (200), and the submitted return changed under it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-602-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier914-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
TODAY=$(TZ=Europe/Berlin date +%F)
# the 10th of the month before last, of last month; the month before last's successor = last month
read -r M2 M1 < <(python3 -c "
import datetime as d
t=d.date.fromisoformat('$TODAY').replace(day=1)
m1=(t-d.timedelta(days=1)).replace(day=10); m2=(m1.replace(day=1)-d.timedelta(days=1)).replace(day=10)
print(m2.isoformat(), m1.isoformat())")
ym() { echo "year=${1:0:4}&month=$((10#${1:5:2}))"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","vatId":"DE811907980"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Paris SARL","type":"business","vatId":"FR40303265045","address":{"street":"Rue 1","postalCode":"75001","city":"Paris","country":"FR"}}'
FR=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 602","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
DE=$(json_field "$BODY" id)
draft() { # customer net rate extra
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"$4,\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  I=$(json_field "$BODY" id)
}
issue() { AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
kz() { AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$1")"; python3 -c "import sys,json;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('$2',0))" "$BODY"; }
zmL() { AS GET "/api/v1/ustva/zm?companyId=$C&$(ym "$1")"; python3 -c "import sys,json;print(json.loads(sys.argv[1])['summen']['L'])" "$BODY"; }

note "=== 1. an igL delivered on $M2, invoiced $TODAY: the month after the delivery ==="
draft "$FR" 1000 0 ",\"euTransaction\":true,\"deliveryDate\":\"$M2\""; issue
assert_eq "issued" "$STATUS" "200"
assert_eq "Kz 41: ${M1:0:7} 1000, this month 0 (was 0 / 1000)" "$(kz "$M1" 41)/$(kz "$TODAY" 41)" "1000/0"
assert_eq "ZM: ${M1:0:7} L 1000, this month 0 (was 0 / 1000)" "$(zmL "$M1")/$(zmL "$TODAY")" "1000/0"
assert_eq "…and not in the month of the delivery" "$(kz "$M2" 41)" "0"
draft "$FR" 500 0 ",\"euTransaction\":true,\"deliveryDate\":\"$M1\""; issue
assert_eq "an igL delivered last month, invoiced now: this month (the invoice is earlier than the deadline)" "$(kz "$M1" 41)/$(kz "$TODAY" 41)" "1000/500"

note "=== 2. last month submitted: an invoice for a supply of last month ==="
AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$M1")"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "the UStVA ${M1:0:7} is submitted" "$STATUS" "201"
draft "$DE" 100 0.19 ",\"deliveryDate\":\"$M1\""; issue
assert_eq "issuing it: 400 (was 200)" "$STATUS" "400"
assert_eq "…as a submitted period" "$(echo "$BODY" | grep -c "wurde.*übermittelt")" "1"
assert_eq "…and the submitted return is unchanged" "$(kz "$M1" 81)" "0"
draft "$DE" 100 0.19 ",\"deliveryDate\":\"$TODAY\""; issue
assert_eq "an invoice for a supply of this month: 200" "$STATUS" "200"

summary
