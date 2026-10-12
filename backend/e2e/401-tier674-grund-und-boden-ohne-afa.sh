#!/bin/bash
# Tier 674 — land is not depreciated.
#
# § 6 Abs. 1 Nr. 2 EStG names „Grund und Boden“ among the assets that are
# not depreciable; § 253 Abs. 3 HGB writes down only what is of limited use.
#
# Before: an asset of the type „Grundstück“ could not be saved without a
# useful life and was depreciated over it like a machine. A plot of
# 100 000 € over 600 months: 2 000 € of AfA a year, and „AfA buchen“ booked
# that as an expense — in the EÜR, the P&L, and off the balance sheet's book
# value. Anlage V counted it into the building's AfA.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-401-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier674-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
SQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -At -c "$1"; }
asset() { echo "{\"type\":\"$1\",\"bezeichnung\":\"$2\",\"anschaffungsDatum\":\"2024-01-15\",\"anschaffungsKosten\":$3,\"nutzungsdauerMonate\":$4}"; }
afa() { AS GET "/api/v1/assets/booking-status?companyId=$C&year=2025"; field "{x['bezeichnung']: x['computedAfA'] for x in d}"; }

note "=== 1. the computation ==="
cat > "$SCRIPT_DIR/../.tier674-probe.ts" <<'TS'
import { computeAfaSummary } from './src/modules/assets/afa'
const a = (type: string) => computeAfaSummary(
  { type, anschaffungsKosten: 100000, restwert: 0, nutzungsdauerMonate: 600, anschaffungsDatum: new Date(2024, 0, 15), verkauftAm: null },
  new Date(2025, 11, 31, 12),
)
console.log(`land=${a('Grundstueck').annualAfA}/${a('Grundstueck').accumulatedAfA}/${a('Grundstueck').buchwert}`)
console.log(`building=${a('Gebaeude').annualAfA}/${a('Gebaeude').accumulatedAfA}/${a('Gebaeude').buchwert}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier674-probe.ts > "$TMP/probe.txt" 2>&1 )
assert_eq "land, even with a useful life stored: no AfA, the book value is the cost (was 2 000 / 4 000 / 96 000)" "$(grep '^land=' "$TMP/probe.txt" | cut -d= -f2)" "0/0/100000"
assert_eq "a building of the same figures: depreciated as before" "$(grep '^building=' "$TMP/probe.txt" | cut -d= -f2)" "2000/4000/96000"

note "=== 2. saving ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier674-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

AS POST "/api/v1/assets?companyId=$C" "$(asset Grundstueck Bauplatz 100000 0)"; LAND=$(field "d['id']")
assert_eq "land without a useful life is saved (was refused: „Nutzungsdauer muss > 0 Monate sein“)" "$STATUS|$(field "d['nutzungsdauerMonate']")" "201|0"
AS POST "/api/v1/assets?companyId=$C" "$(asset Grundstueck Acker 50000 600)"
assert_eq "land entered with a useful life: saved without one" "$STATUS|$(field "d['nutzungsdauerMonate']")" "201|0"
AS POST "/api/v1/assets?companyId=$C" "$(asset Gebaeude Halle 300000 0)"
assert_eq "a building still needs one" "$STATUS" "400"
AS POST "/api/v1/assets?companyId=$C" "$(asset Gebaeude Halle 300000 396)"; HALLE=$(field "d['id']")
assert_eq "… and is saved with it" "$STATUS|$(field "d['nutzungsdauerMonate']")" "201|396"

AS PATCH "/api/v1/assets/$LAND?companyId=$C" '{"nutzungsdauerMonate":240}'
assert_eq "a useful life cannot be put on land afterwards" "$STATUS|$(field "d['nutzungsdauerMonate']")" "200|0"
AS PATCH "/api/v1/assets/$LAND?companyId=$C" '{"type":"Gebaeude"}'
assert_eq "land turned into a building needs a useful life" "$STATUS" "400"
AS PATCH "/api/v1/assets/$HALLE?companyId=$C" '{"type":"Grundstueck"}'
assert_eq "a building turned into land loses its" "$STATUS|$(field "d['nutzungsdauerMonate']")" "200|0"
AS PATCH "/api/v1/assets/$HALLE?companyId=$C" '{"type":"Gebaeude","nutzungsdauerMonate":396}'
assert_eq "… and gets one again as a building" "$STATUS|$(field "d['nutzungsdauerMonate']")" "200|396"

note "=== 3. no AfA is computed or booked for land ==="
assert_eq "2025: the hall 9 090,91 €, the land nothing (the plot was 2 000 €)" "$(afa)" "{'Bauplatz': 0, 'Acker': 0, 'Halle': 9090.91}"
# a row from before: land with a useful life in the database
SQL "UPDATE \"Asset\" SET \"nutzungsdauerMonate\" = 600 WHERE id = '$LAND'" >/dev/null
assert_eq "… also for land stored with a useful life before" "$(afa)" "{'Bauplatz': 0, 'Acker': 0, 'Halle': 9090.91}"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2025" '{}'
assert_eq "„AfA buchen“: one booking, the hall's" "$STATUS|$(field "(d['bookedCount'], d['totalAnnualAfA'], [b['assetName'] for b in d['booked']])")" "201|(1, 9090.91, ['Halle'])"
assert_eq "… and one AfA expense in the books" "$(SQL "SELECT count(*) || '/' || sum(\"netAmount\") FROM \"Expense\" WHERE \"companyId\" = '$C' AND category = 'AfA'" | sed 's/0*$//; s/\.$//')" "1/-9090.91"
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=2025"
assert_eq "Anlage V: the building's AfA only" "$(field "[l['amount'] for l in d['werbungskosten'] if l['kennziffer'] == '8600'][0]")" "9090.91"

note "=== 4. on the page ==="
FE="$SCRIPT_DIR/../../frontend"
PAGE="$FE/src/app/dashboard/assets/page.tsx"
grep -q 'asset.type === "Grundstueck" ? 0 : asset.nutzungsdauerMonate' "$PAGE" && pass "the page's own computation follows" || fail "the page still depreciates land"
grep -q 'data-testid="assets-draft-land-hint"' "$PAGE" && pass "the form says why land has no useful life" || fail "no hint on the form"
for lang in de en zh; do
  python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1],encoding='utf-8'))['assets'].get('landNoAfa') else 1)" "$FE/messages/$lang.json" \
    && pass "the hint: $lang" || fail "hint missing: $lang"
done

summary
