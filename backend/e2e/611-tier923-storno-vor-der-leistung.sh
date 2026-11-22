#!/bin/bash
# Tier 923 — a credit note not before the supply of the invoice it corrects
#
# Since Tiers 919 / 921 a Vorausrechnung is in the period of its supply; its
# credit note stayed in the period of its own date. Measured: a Vorausrechnung
# for a delivery on 05.01. next year, cancelled in full today — UStVA this
# month −1 000 €, January +1 000 €; GuV this year −1 000, next year +1 000; the
# OSS the same by quarter. The sale never took place: 0 everywhere.
# § 17 Abs. 1 Satz 7 UStG: the correction in the period of the change — never
# before the period in which the corrected sale is taxed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-611-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; NY=$((Y + 1)); M=$((10#${TODAY:5:2})); Q=$(( (M - 1) / 3 + 1 ))
LM=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$TODAY').replace(day=1)-d.timedelta(days=1);print(t.replace(day=10).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier923-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Soll, OSS)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","ossVerfahren":true}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 611","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
DE=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont 611","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
FR=$(json_field "$BODY" id)
invoice() { # customer delivery net rate
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$2\",\"items\":[{\"description\":\"Lieferung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$3,\"vatRate\":$4}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
storno() { AS POST "/api/v1/invoices/$1/credit-note?companyId=$C" '{}'; }
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)"; }
umsatz() { AS GET "/api/v1/accounting/guv?companyId=$C&year=$1"; P "d['totals']['umsatzerloese']"; }
ossVat() { AS GET "/api/v1/reports/oss?companyId=$C&year=$1&quarter=$2"; P "round(d['totals']['vatAmount'] + sum(c['vat'] for c in d.get('corrections', [])), 2)"; }

note "=== a Vorausrechnung for 05.01.$NY, cancelled in full today ==="
invoice "$DE" "$NY-01-05" 1000 0.19; storno "$I"
assert_eq "the Storno" "$STATUS" "201"
assert_eq "UStVA this month 0 (was −1 000), January $NY 0 (was 1 000)" "$(kz81 $Y $M)/$(kz81 $NY 1)" "0/0"
assert_eq "GuV $Y 0 (was −1 000), $NY 0 (was 1 000)" "$(umsatz $Y)/$(umsatz $NY)" "0/0"

note "=== a supply of last month, cancelled today: the change is this month's, as before ==="
invoice "$DE" "$LM" 500 0.19; storno "$I"
assert_eq "UStVA last month +500, this month −500" "$(kz81 ${LM:0:4} $((10#${LM:5:2})))/$(kz81 $Y $M)" "500/-500"

note "=== OSS: an order shipped next quarter, unpaid, cancelled today ==="
read -r NQY NQ NEXTQ < <(python3 -c "
y,q=$Y,$Q
ny,nq=(y+1,1) if q==4 else (y,q+1)
print(ny, nq, f'{ny}-{(nq-1)*3+1:02d}-02')")
invoice "$FR" "$NEXTQ" 1000 0.2; storno "$I"
assert_eq "OSS this quarter 0, next quarter 0 (was −200 / +200)" "$(ossVat $Y $Q)/$(ossVat $NQY $NQ)" "0/0"

summary
