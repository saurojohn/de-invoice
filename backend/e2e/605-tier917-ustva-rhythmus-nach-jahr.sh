#!/bin/bash
# Tier 917 — the UStVA rhythm of a calendar year
#
# The Voranmeldungszeitraum is set for a calendar year (§ 18 Abs. 2 UStG). It
# was one value, settings.ustvaRhythmus, read for every period: a company that
# went from monthly to quarterly with the new year was told in January that
# last year's quarters were due / overdue — and not that December's return
# was due on the 10th. Now a change applies from a year on
# (settings.ustvaRhythmusAb); the years before keep theirs.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-605-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

note "=== the periods looked at, each in its year's rhythm ==="
OUT=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const name = (ps) => ps.map(f.periodName).join(', ')
const by = (m) => (y) => m[y] ?? m.other
console.log([
  name(f.endedUstvaPeriods('2027-01-05', by({ 2027: 'quarterly', other: 'monthly' }))),
  name(f.endedUstvaPeriods('2027-02-05', by({ 2027: 'monthly', other: 'quarterly' }))),
  name(f.endedUstvaPeriods('2027-01-05', by({ 2027: 'none', other: 'monthly' }))),
  name(f.endedUstvaPeriods('2026-11-22', by({ other: 'monthly' }))),
  f.rhythmOfYear({ ustvaRhythmus: 'monthly', ustvaRhythmusAb: { 2027: 'quarterly' } }, 2026),
  f.rhythmOfYear({ ustvaRhythmus: 'monthly', ustvaRhythmusAb: { 2027: 'quarterly' } }, 2028),
].join('\n'))
" 2>&1)
J() { echo "$OUT" | sed -n "${1}p"; }
assert_eq "January 2027, quarterly from 2027: last year's months (was 3. / 4. Quartal 2026)" "$(J 1)" "Oktober 2026, November 2026, Dezember 2026"
assert_eq "February 2027, monthly from 2027: January, and last year's quarters" "$(J 2)" "3. Quartal 2026, 4. Quartal 2026, Januar 2027"
assert_eq "January 2027, no more returns from 2027: December's is still due" "$(J 3)" "Oktober 2026, November 2026, Dezember 2026"
assert_eq "without a change: as before" "$(J 4)" "August 2026, September 2026, Oktober 2026"
assert_eq "a change holds from its year, the years before keep the single value" "$(J 5)/$(J 6)" "monthly/quarterly"

note "=== the setting ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier917-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
Y=$(TZ=Europe/Berlin date +%Y)
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"monthly"}'
assert_eq "monthly: the first setting is every year's" "$STATUS/$(q "select settings->>'ustvaRhythmus', settings->'ustvaRhythmusAb' from \"Company\" where id='$C'")" "200/monthly|"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" "{\"ustvaRhythmus\":\"quarterly\",\"year\":$((Y + 1))}"
assert_eq "quarterly from next year" "$STATUS/$(P "(d['rhythm'], d['rhythmNextYear'])")" "200/('monthly', 'quarterly')"
assert_eq "…stored for $((Y + 1)), this year's unchanged" "$(q "select settings->>'ustvaRhythmus', settings->'ustvaRhythmusAb' from \"Company\" where id='$C'")" "monthly|{\"$((Y + 1))\": \"quarterly\"}"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" "{\"ustvaRhythmus\":\"quarterly\",\"year\":$((Y + 2))}"
assert_eq "a year after next: 400" "$STATUS" "400"
AS POST "/api/v1/ustva/calendar?companyId=$C" '{}'
URL=$(P "d['url']"); T=${URL##*/}
curl -sS -o "$TMP/feed.ics" "$API/api/v1/calendar/$T"
assert_eq "the calendar: next year's first return is the quarter's (was January's)" \
  "$(grep -c "SUMMARY:UStVA Q1 $((Y + 1))" "$TMP/feed.ics")/$(grep -c "SUMMARY:UStVA Januar $((Y + 1))" "$TMP/feed.ics")" "1/0"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":null}'
assert_eq "null clears both: the books decide" "$(q "select coalesce(settings->>'ustvaRhythmus','-'), coalesce(settings->>'ustvaRhythmusAb','-') from \"Company\" where id='$C'")" "-|-"

summary
