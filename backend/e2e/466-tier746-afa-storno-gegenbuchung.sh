#!/bin/bash
# Tier 746 — the AfA storno reverses a booking, it does not delete it
#
# POST /assets/storno-afa deleted the year's AfA rows; only the audit log still
# knew they had existed. The owner, 30.10.2026 (§9 item 15): „反向分录". Each
# booking now stays and gets a counter-entry: same day, same AfA period,
# opposite sign. Both are marked, so every sum of the year is zero for the pair
# and the year can be booked again, in either mode.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-466-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier746-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
ASSET='{"type":"Maschine","bezeichnung":"Presse","anschaffungsDatum":"2026-01-01","anschaffungsKosten":6000,"nutzungsdauerMonate":60,"restwert":0,"afaMethode":"linear","bilanzKonto":"0210"}'
AS POST "/api/v1/assets?companyId=$C" "$ASSET"
A=$(json_field "$BODY" id)
[[ -n "$A" ]] && pass "fixture: a machine, 1 200 € a year" || fail "asset: $BODY"
rows() { q "SELECT count(*), coalesce(sum(\"netAmount\"),0)::numeric(12,2), count(*) FILTER (WHERE \"afaReversedAt\" IS NULL) FROM \"Expense\" WHERE \"companyId\"='$C' AND category='AfA';"; }
guv() { AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"; P "d['totals']['jahresueberschuss']"; }
status() { AS GET "/api/v1/assets/booking-status?companyId=$C&year=2026"; P "[(r['booked'], r['bookedAfA']) for r in d]"; }
datev() { curl -sS -o /tmp/t466.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-01-01&endDate=2026-12-31"; datev_balance /tmp/t466.csv 0210; }

note "=== 1. booked ==="
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2026"
assert_eq "one booking, stored negative" "$(rows)" "1|-1200.00|1"
assert_eq "GuV: -1 200" "$(guv)" "-1200"
assert_eq "DATEV: the asset account takes 1 200 in Haben" "$(datev)" "-1200.00"
ORIG=$(q "SELECT id FROM \"Expense\" WHERE \"companyId\"='$C' AND category='AfA';")

note "=== 2. the storno ==="
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
assert_eq "the answer: one booking, 1 200" "$STATUS/$(P "(d['stornoedCount'], d['stornoedTotal'])")" "201/(1, 1200)"
assert_eq "the booking stays, a counter-entry beside it: the pair is zero, none stands (was: gone)" "$(rows)" "2|0.00|0"
assert_eq "the counter-entry: names the booking, same day and period, opposite sign, says what it is" \
  "$(q "SELECT r.\"invoiceDate\" = o.\"invoiceDate\", r.\"afaYear\", r.\"netAmount\"::numeric(12,2), r.\"relatedAssetId\" = o.\"relatedAssetId\", r.description LIKE 'Storno: AfA %' FROM \"Expense\" r JOIN \"Expense\" o ON o.id = r.\"reversesExpenseId\" WHERE o.id='$ORIG';")" "t|2026|1200.00|t|t"
assert_eq "booking status: not booked" "$(status)" "[(False, 0)]"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "GuV: no booking counted — it falls back to its computed AfA, and says so (as for a year never booked)" \
  "$(P "d['afaSource']")" "computed"
assert_eq "DATEV: the counter-entry takes it back, S/H turned (a storno row of the same sign would double it)" "$(datev)" "0.00"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
[[ "$STATUS" == "200" ]] && assert_eq "EÜR: no AfA" "$(P "str(d).count('1200')")" "0"
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
assert_eq "a second storno finds nothing" "$(P "d['stornoedCount']")/$(rows)" "0/2|0.00|0"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "both stand in the list of expenses" "$(P "sorted(float(e['netAmount']) for e in d['data'])")" "[-1200.0, 1200.0]"
REV=$(q "SELECT id FROM \"Expense\" WHERE \"reversesExpenseId\"='$ORIG';")
AS DELETE "/api/v1/ustva/expenses/$REV?companyId=$C"
assert_eq "the counter-entry cannot be deleted by hand" "$STATUS/$(P "'AfA' in d['message']")" "400/True"

note "=== 3. booked again, in either mode ==="
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2026"
assert_eq "yearly: booked" "$(P "d['bookedCount']")/$(rows)" "1/3|-1200.00|1"
assert_eq "GuV: -1 200" "$(guv)" "-1200"
assert_eq "DATEV: -1 200" "$(datev)" "-1200.00"
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
AS POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=2026"
assert_eq "monthly after a storno: 12 bookings" "$(P "d['bookedCount']")/$(rows)" "12/16|-1200.00|12"
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
assert_eq "a monthly storno: 12 taken back, each with its month" \
  "$(P "d['stornoedCount']")/$(q "SELECT count(DISTINCT \"afaMonth\") FROM \"Expense\" WHERE \"companyId\"='$C' AND \"reversesExpenseId\" IS NOT NULL;")/$(rows)" "12/12/28|0.00|0"

note "=== 4. closed books ==="
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2026"
BEFORE=$(rows)
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-01-31","reason":"Spec 466"}'
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
assert_eq "refused, nothing written" "$STATUS/$(rows)" "400/$BEFORE"

summary
