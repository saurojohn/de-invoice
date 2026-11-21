#!/bin/bash
# Tier 908 — Soll- or Ist-Versteuerung by date: a sale is taxed once
#
# Measured: a 1 000 € invoice of October, taxed and filed under Soll (Kz 81,
# 190 €); the company switched to Ist in November and was paid in November —
# the November UStVA declared the 190 € again, and October, computed anew,
# showed nothing (the filed return no longer matched). The other way an
# invoice issued under Ist and paid after the switch to Soll was in no return.
#
# Now a switch applies from the first of a month (besteuerungsartAb, default
# the current one); a sale is taxed at its issue if the company was a
# Soll-Versteuerer that day, else when paid — whenever that is.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
THIS="$Y-$(printf %02d $M)-01"
# the two months before this one (a December of last year included)
P1=$(python3 -c "import datetime as d;t=d.date($Y,$M,1);p=(t-d.timedelta(days=1)).replace(day=1);print(p.isoformat())")
P2=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$P1');p=(t-d.timedelta(days=1)).replace(day=1);print(p.isoformat())")
ym() { echo "year=${1:0:4}&month=$((10#${1:5:2}))"; }

company() { # tag art → sets U C
  local tag="e2e-596-$1-$(date +%s%N | cut -c1-13)"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$tag@example.test\",\"password\":\"Tier908-e2e\",\"companyName\":\"$tag\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"Einzelunternehmen\",\"besteuerungsart\":\"$2\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 596","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
issue() { # date net → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"; }
vat19() { # month-start → the 19 % VAT of that month
  AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$1")"
  python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(next((round(r['vat'],2) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-6), 0))" "$BODY"
}

note "=== 1. Soll → Ist: what was taxed at issue is not taxed again when paid ==="
company soll soll
A=$(issue "$P1" 1000)
assert_eq "fixture: last month, Soll — 190 € declared" "$(vat19 "$P1")" "190"
AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$P1")"
FILED=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$FILED"
assert_eq "…and filed" "$STATUS" "201"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"besteuerungsart\":\"ist\",\"besteuerungsartAb\":\"$P1\"}"
assert_eq "a switch from last month, which is filed: refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"besteuerungsart\":\"ist\",\"besteuerungsartAb\":\"$Y-$(printf %02d $((M == 12 ? 12 : M + 1)))-01\"}"
[[ $M == 12 ]] && pass "(December: no month to come in this year)" || assert_eq "a switch from a month to come: refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
assert_eq "switched to Ist (from this month, the default)" "$STATUS" "200"
B=$(issue "$TODAY" 500)
pay "$A" 1190; pay "$B" 595
assert_eq "this month: only B's 95 € — A's 190 € were declared last month (was 285)" "$(vat19 "$THIS")" "95"
assert_eq "last month still the 190 € filed (was 0)" "$(vat19 "$P1")" "190"

note "=== 2. Ist → Soll: what was issued under Ist is taxed when paid ==="
company ist ist
D=$(issue "$P2" 2000)
assert_eq "fixture: two months ago, Ist, unpaid — nothing declared" "$(vat19 "$P2")" "0"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"besteuerungsart\":\"soll\",\"besteuerungsartAb\":\"$P1\"}"
assert_eq "switched to Soll from last month" "$STATUS" "200"
E=$(issue "$TODAY" 100)
pay "$D" 2380
assert_eq "this month: D's 380 € on payment + E's 19 € at issue (was 19 — D in no return)" "$(vat19 "$THIS")" "399"
assert_eq "two months ago: still nothing" "$(vat19 "$P2")" "0"

note "=== 3. nothing issued before: the setting changes as a whole ==="
company neu soll
F=$(issue "$P1" 300)
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"besteuerungsart\":\"ist\",\"besteuerungsartAb\":\"$P1\"}"
assert_eq "switched from the month of the first invoice" "$STATUS" "200"
assert_eq "…last month: nothing — Ist from the start" "$(vat19 "$P1")" "0"
pay "$F" 357
assert_eq "…paid this month: 57 €" "$(vat19 "$THIS")" "57"
AS GET "/api/v1/companies/$C?companyId=$C"
assert_eq "…no switch kept" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('settings',{}).get('besteuerungsartWechsel'))" "$BODY")" "[]"

summary
