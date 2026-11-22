#!/bin/bash
# Tier 913 — the earlier of the supply and the invoice
#
# 1. UStVA: Tier 912 put an invoice into the period of its supply. For an
#    invoice written before the supply (a shop's prepayment, shipped next
#    month) that moved the tax to the later month — but a payment received on
#    it is owed when received (§ 13 Abs. 1 Nr. 1 a Satz 4 UStG). It stays in
#    the invoice's period now: never declared late.
# 2. GuV / Bilanz of a GmbH: revenue counted by the issue date. Measured: a
#    supply of 15.12. last year, invoiced this year, was this year's revenue,
#    last year's balance sheet had no claim for it and its KSt 1 no profit
#    (§ 252 Abs. 1 Nr. 4 HGB — realised with the supply).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-601-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier913-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
NEXT=$(python3 -c "import datetime as d;t=d.date($Y,$M,28)+d.timedelta(days=10);print(t.replace(day=3).isoformat())")
ym() { echo "year=${1:0:4}&month=$((10#${1:5:2}))"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 601","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
issue() { # net extra
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\"$2,\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&$1"; python3 -c "import sys,json;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('81',0))" "$BODY"; }

note "=== 1. an invoice before its supply stays in its own month ==="
issue 300 ",\"deliveryDate\":\"$NEXT\""
assert_eq "invoiced today, delivered next month: this month (Tier 912 had next month)" "$(kz81 "$(ym "$TODAY")")/$(kz81 "$(ym "$NEXT")")" "300/0"

note "=== 2. a supply of last December, invoiced this year: last year's revenue and claim ==="
issue 400 ",\"deliveryDate\":\"$((Y - 1))-12-15\""
AS GET "/api/v1/accounting/guv?companyId=$C&year=$((Y - 1))"
assert_eq "GuV $((Y - 1)): Umsatzerlöse 400 (was 0)" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['umsatzerloese'])" "$BODY")" "400"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV $Y: only the 300 (was 700)" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['umsatzerloese'])" "$BODY")" "300"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$((Y - 1))"
assert_eq "Bilanz 31.12.$((Y - 1)): a claim of 476 € (was 0)" \
  "$(python3 -c "
import sys,json
d=json.loads(sys.argv[1])
print(next(l['amount'] for s in d['aktiva'] for l in s['lines'] if l['label']=='Forderungen aus Lieferungen und Leistungen'))" "$BODY")" "476"
assert_eq "…and it balances" "$(python3 -c "import sys,json;b=json.loads(sys.argv[1])['balanceCheck'];print(b.get('balanced', b.get('ok', b)))" "$BODY")" "True"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$((Y - 1))"
assert_eq "KSt 1 $((Y - 1)): a profit to tax (was none)" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['zve'] > 0)" "$BODY")" "True"

summary
