#!/bin/bash
# Tier 991 — the cash book's month: output tax and input tax apart
#
# A cash sale of 119 € at 19 % and a cash purchase of 119 € at 19 % in one
# month: /cashbook/month said „19 %: Netto 200, MwSt 38, Brutto 238“ — the
# UStVA of that month owes nothing (Kz 81 100 / Kz 66 19). Every entry with a
# rate went in, whatever its kind; entries the UStVA does not count from the
# cash book (paying an invoice or a bill) as well.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-678-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier991-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
CE() { AS POST "/api/v1/cashbook/entries?companyId=$C" "$1"; }
CE "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":500}"
CE "{\"businessDate\":\"$D\",\"type\":\"einnahme\",\"description\":\"Verkauf\",\"amount\":119,\"vatRate\":0.19}"
CE "{\"businessDate\":\"$D\",\"type\":\"ausgabe\",\"description\":\"Einkauf\",\"amount\":119,\"vatRate\":0.19}"
AS GET "/api/v1/cashbook/month?companyId=$C&year=${D:0:4}&month=$((10#${D:5:2}))"
assert_eq "output tax and input tax apart: in 100/19, out 100/19 (was one line 200/38)" \
  "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(sorted((v.get('direction'), float(v['net']), float(v['vat'])) for v in d['vatBreakdown']))" "$BODY")" \
  "[('in', 100.0, 19.0), ('out', 100.0, 19.0)]"

summary
