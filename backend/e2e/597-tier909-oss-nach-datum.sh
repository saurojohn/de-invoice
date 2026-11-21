#!/bin/bash
# Tier 909 — the One-Stop-Shop by date
#
# Measured: a company outside the OSS sold for 1 000 € at 19 % to a consumer
# in Paris last month — German tax, Kz 81, filed. Turning `ossVerfahren` on
# moved it: last month, computed anew, had it in Kz 45 with no German tax, and
# the OSS return of the quarter declared its 190 € for France — a second time.
# Now a change applies from the first of a month (ossVerfahrenAb, default the
# current one; not in a filed period); each sale is the OSS's by its own day.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
THIS="$Y-$(printf %02d $M)-01"
P1=$(python3 -c "import datetime as d;t=d.date($Y,$M,1);print((t-d.timedelta(days=1)).replace(day=1).isoformat())")
ym() { echo "year=${1:0:4}&month=$((10#${1:5:2}))"; }
quarter() { echo "year=${1:0:4}&quarter=$(( (10#${1:5:2} - 1) / 3 + 1 ))"; }

AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
company() { # tag oss(true|false) → U C K (a consumer in Paris)
  local tag="e2e-597-$1-$(date +%s%N | cut -c1-13)"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$tag@example.test\",\"password\":\"Tier909-e2e\",\"companyName\":\"$tag GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"GmbH\",\"ossVerfahren\":$2}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont 597","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
  K=$(json_field "$BODY" id)
}
sale() { # date net rate
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
kz() { # month-start → "Kz81 Kz45"
  AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$1")"
  python3 -c "import sys,json;d={k['kz']:k['value'] for k in json.loads(sys.argv[1])['kennzahlen'] if k.get('value')};print(d.get('81',0), d.get('45',0))" "$BODY"
}
ossVat() { # month-start → the OSS tax of its quarter
  AS GET "/api/v1/reports/oss?companyId=$C&$(quarter "$1")"
  python3 -c "import sys,json;print(round(json.loads(sys.argv[1])['totals']['vatAmount'],2))" "$BODY"
}

note "=== 1. joining the OSS: the sales before stay German ==="
company join false
sale "$P1" 1000 0.19
assert_eq "fixture: last month, outside the OSS — German tax (Kz 81)" "$(kz "$P1")" "1000 0"
AS GET "/api/v1/ustva/compute?companyId=$C&$(ym "$P1")"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
assert_eq "…and filed" "$STATUS" "201"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"ossVerfahren\":true,\"ossVerfahrenAb\":\"$P1\"}"
assert_eq "joining from last month, which is filed: refused" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":true}'
assert_eq "joined (from this month, the default)" "$STATUS" "200"
sale "$TODAY" 500 0.2
assert_eq "last month: still Kz 81 (was Kz 45, no German tax)" "$(kz "$P1")" "1000 0"
assert_eq "this month: the French sale in Kz 45" "$(kz "$THIS")" "0 500"
if [[ "$(quarter "$P1")" == "$(quarter "$THIS")" ]]; then
  assert_eq "the OSS return of the quarter: only this month's 100 € (was 290)" "$(ossVat "$THIS")" "100"
else
  assert_eq "the OSS return of last month's quarter: nothing (was 190)" "$(ossVat "$P1")" "0"
fi

note "=== 2. leaving the OSS: the sales before stay the OSS's ==="
company leave true
sale "$P1" 1000 0.19
assert_eq "fixture: last month, in the OSS — Kz 45" "$(kz "$P1")" "0 1000"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":false}'
assert_eq "left (from this month)" "$STATUS" "200"
sale "$TODAY" 200 0.19
assert_eq "last month: still Kz 45 (was Kz 81 — German tax on a sale declared in the OSS)" "$(kz "$P1")" "0 1000"
assert_eq "this month: German tax again (Kz 81)" "$(kz "$THIS")" "200 0"

note "=== 3. nothing issued before: the setting changes as a whole ==="
company neu false
sale "$P1" 300 0.19
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"ossVerfahren\":true,\"ossVerfahrenAb\":\"$P1\"}"
assert_eq "joined from the month of the first invoice" "$STATUS" "200"
assert_eq "…last month: Kz 45 — in the OSS from the start" "$(kz "$P1")" "0 300"
AS GET "/api/v1/companies/$C?companyId=$C"
assert_eq "…no change kept" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('settings',{}).get('ossWechsel'))" "$BODY")" "[]"

summary
