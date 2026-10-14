#!/bin/bash
# Tier 687 — reports and exchange rates count days in Germany, not in UTC
#
# CI run 38643531009 crossed midnight in Berlin (00:10 on 15.10.2026, 22:10
# UTC on the 14th). Two specs went red:
#   - 390: the sales and customer reports defaulted to "1 January of the
#     server's year up to now" — an invoice dated today (15.10.) was after
#     "now" (14.10. 22:10 UTC) and left out: net sales 0 instead of 10 216,59.
#   - 386: the ECB rate of an invoice dated today was looked up with the UTC
#     date as "today" — the invoice counted as dated in the future and got
#     yesterday's rate (and date).
# The DATEV routes had the same defaults, and the dashboard's year started on
# the server's 1 January: before 02:00 on New Year's Day the dashboard would
# have shown last year as "this year".
#
# The backend's clock cannot be moved in a spec, so this checks the day
# arithmetic with fixed instants, and that the places use it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SRC="$SCRIPT_DIR/../src"

note "=== 1. the German day, at instants where it is not the UTC day ==="
OUT=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e '
import { businessYearStart, businessTodayEnd, businessTodayIso } from "./src/common/business-date"
const at = (s: string) => new Date(s)
const iso = (d: Date) => d.toISOString()
console.log([
  businessTodayIso(at("2026-10-14T22:10:00Z")),
  iso(businessTodayEnd(at("2026-10-14T22:10:00Z"))),
  iso(businessYearStart(at("2026-10-14T22:10:00Z"))),
  iso(businessYearStart(at("2026-12-31T23:30:00Z"))),
  iso(businessTodayEnd(at("2026-12-31T23:30:00Z"))),
  iso(businessTodayEnd(at("2026-03-01T12:00:00Z"))),
].join(" "))' 2>&1 | tail -1)
assert_eq "22:10 UTC on 14.10. is 15.10. in Germany; the period ends with that day" "$(echo "$OUT" | cut -d' ' -f1-2)" "2026-10-15 2026-10-15T23:59:59.999Z"
assert_eq "…and starts on 1 January of that year" "$(echo "$OUT" | cut -d' ' -f3)" "2026-01-01T00:00:00.000Z"
assert_eq "23:30 UTC on 31.12. is New Year's Day: the new year's period" "$(echo "$OUT" | cut -d' ' -f4-5)" "2027-01-01T00:00:00.000Z 2027-01-01T23:59:59.999Z"
assert_eq "a plain day stays that day (winter time)" "$(echo "$OUT" | cut -d' ' -f6)" "2026-03-01T23:59:59.999Z"

note "=== 2. the places use it ==="
utc_defaults() { grep -n "new Date(new Date().getFullYear(), 0, 1)\|?? new Date()$\|?? new Date();" "$@" 2>/dev/null | wc -l | tr -d ' '; }
assert_eq "no report route defaults to the server's year or to the current instant (was: 9 lines in the sales and DATEV routes)" \
  "$(utc_defaults "$SRC"/modules/reports/*.controller.ts)" "0"
assert_eq "the sales and DATEV routes default to the German year and today" \
  "$(grep -c "businessYearStart()" "$SRC/modules/reports/sales-report.controller.ts") $(grep -c "businessTodayEnd()" "$SRC/modules/reports/sales-report.controller.ts") $(grep -c "businessYearStart()" "$SRC/modules/reports/datev-export.controller.ts") $(grep -c "businessTodayEnd()" "$SRC/modules/reports/datev-export.controller.ts")" "2 2 4 4"
assert_eq "the dashboard's year is the German year (was: new Date(now.getFullYear(), 0, 1))" \
  "$(grep -c "new Date(now.getFullYear(), 0, 1)" "$SRC/modules/reports/dashboard.controller.ts") $(grep -c "businessYearStart(now)" "$SRC/modules/reports/dashboard.controller.ts")" "0 1"
assert_eq "the ECB rate lookup takes today from the German calendar (was: ymdOf(new Date()), the UTC date)" \
  "$(grep -c "const today = ymdOf(new Date())" "$SRC/modules/exchange-rate/exchange-rate.service.ts") $(grep -c "const today = businessTodayIso()" "$SRC/modules/exchange-rate/exchange-rate.service.ts")" "0 1"

note "=== 3. today's invoice is in today's report (the daytime case) ==="
login
TAG="e2e-411-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier687-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde AG","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"}}'
K=$(P "d['id']")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"heute\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(P "d['id']")
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/reports/sales?companyId=$C"
assert_eq "the sales report without a period: today's invoice is in it" "$STATUS $(P "(d['totalSales'], d['totalVat'])")" "200 (100, 19)"
AS GET "/api/v1/reports/customers?companyId=$C"
assert_eq "the customer report too" "$STATUS $(P "d['summary']['totalAmount']")" "200 119"

summary
