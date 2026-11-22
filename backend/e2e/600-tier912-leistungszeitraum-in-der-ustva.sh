#!/bin/bash
# Tier 912 — an invoice is in the return of the period of its supply
#
# § 13 Abs. 1 Nr. 1 a UStG: under Soll-Versteuerung the tax arises with the end
# of the period in which the supply was made. The returns read the issue date
# only. Measured: a supply of last month (Leistungsdatum), invoiced today, was
# declared this month; one of last December — in this year's UStJA instead of
# last year's. An innergemeinschaftliche Lieferung stays with its invoice
# (§ 18b Satz 2 UStG), a credit note with the period of the change (§ 17).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-600-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier912-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
P1=$(python3 -c "import datetime as d;t=d.date($Y,$M,1);print((t-d.timedelta(days=1)).replace(day=1).isoformat())")
P1MID="${P1:0:8}20"; P1START="${P1:0:8}01"; P1END=$(python3 -c "import datetime as d;t=d.date($Y,$M,1);print((t-d.timedelta(days=1)).isoformat())")
LASTDEC="$((Y - 1))-12-15"
ym() { echo "year=${1:0:4}&month=$((10#${1:5:2}))"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","vatId":"DE811907980"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 600","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Paris 600 SARL","type":"business","vatId":"FR12345678901","address":{"street":"Rue 1","postalCode":"75001","city":"Paris","country":"FR"}}'
KFR=$(json_field "$BODY" id)
# issue CUSTOMER NET RATE [EXTRA] → id
issue() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"${4:-},\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  [[ "$STATUS" == 200 ]] || echo "issue: $STATUS $BODY" >&2
  echo "$id"
}
kz() { # period query → "Kz81 Kz41"
  AS GET "/api/v1/ustva/compute?companyId=$C&$1"
  python3 -c "import sys,json;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('81',0), d.get('41',0))" "$BODY"
}

A=$(issue "$K" 1000 0.19 ",\"deliveryDate\":\"$P1MID\"")
issue "$K" 200 0.19 ",\"servicePeriodStart\":\"$P1START\",\"servicePeriodEnd\":\"$P1END\"" >/dev/null
issue "$K" 50 0.19 >/dev/null
issue "$KFR" 300 0 ",\"euTransaction\":true,\"deliveryDate\":\"$P1MID\"" >/dev/null
issue "$K" 400 0.19 ",\"deliveryDate\":\"$LASTDEC\"" >/dev/null

assert_eq "last month: the supply of the 20th (1 000) and the service period (200) — was 0" "$(kz "$(ym "$P1")")" "1200 0"
assert_eq "this month: only the invoice without a date of supply (50); the igL with its invoice (300) — was 1 650 / 300" "$(kz "$(ym "$TODAY")")" "50 300"
assert_eq "last December: the supply of 15.12. (400) — was in this year" "$(kz "year=$((Y - 1))&month=12")" "400 0"
assert_eq "…and in last year's UStJA, not this year's" "$(kz "year=$((Y - 1))" | cut -d' ' -f1)/$(kz "year=$Y" | cut -d' ' -f1)" "400/1250"

AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"amount":119}'
assert_eq "a credit note on A: in this month, the period of the change (§ 17)" "$(kz "$(ym "$TODAY")")/$(kz "$(ym "$P1")")" "-50 300/1200 0"

summary
