#!/bin/bash
# Tier 664 — Anlage SO: the kinds of asset and their holding periods
#
# § 23 Abs. 1 Satz 1 EStG (read from gesetze-im-internet.de, 10.10.2026):
#   Nr. 1  land and rights in land              taxable within ten years
#   Nr. 2  other assets — gold, art, crypto …   taxable within one year
# and a security bought since 2009 is not a private sale at all: its result
# is capital income whatever the holding period (§ 20 Abs. 2, Anlage KAP).
#
# The form knew two kinds: "Wertpapier" (one year) and "Sonstige" (ten
# years). Gold sold after two years was shown as taxable; shares sold after
# six months were taxed here, at the personal rate, and after two years shown
# as tax-free; land was a placeholder; crypto was filed as a security to get
# its year, and lines 32 and 34 printed the same sum. The page's service did
# not set the year's losses off against its gains (§ 23 Abs. 3 Satz 7), the
# package's did — the two disagreed about the same data.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-394-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier664-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
Y=2026
tx() { echo "{\"type\":\"$1\",\"description\":\"$2\",\"acquisitionDate\":\"$3\",\"acquisitionCost\":$4,\"saleDate\":\"$5\",\"salePrice\":$6}"; }
put() { AS PUT "/api/v1/accounting/anlage-so/settings?companyId=$C" "{\"year\":$Y,\"transactions\":[$1],\"wiederkehrendeBezuege\":0,\"werbungskosten\":0}"; }
v1() { AS GET "/api/v1/accounting/anlage-so?companyId=$C&year=$Y"; }
v2() { AS GET "/api/v1/accounting/anlage-so/v2?companyId=$C&year=$Y"; }
line() { field "[l['amount'] for l in d['lines'] if l['kennziffer'] == '$1'][0]"; }

note "=== 1. the rules themselves ==="
cat > "$SCRIPT_DIR/../.tier664-probe.ts" <<'TS'
import { statusOf, kindOf, vgSummary, freigrenzeFor } from './src/modules/accounting/anlage-so-rules'
const t = (type: string, description: string, a: string, s: string, cost = 1000, price = 3000) =>
  ({ type, description, acquisitionDate: a, acquisitionCost: cost, saleDate: s, salePrice: price })
const out: Array<[string, unknown]> = [
  ['gold6m', statusOf(t('sonstige', 'Goldbarren', '2026-01-10', '2026-07-10'))],
  ['gold2y', statusOf(t('sonstige', 'Goldbarren', '2024-01-10', '2026-07-10'))],
  ['day365', statusOf(t('krypto', 'BTC', '2025-03-15', '2026-03-15'))],
  ['day366', statusOf(t('krypto', 'BTC', '2025-03-15', '2026-03-16'))],
  ['land8y', statusOf(t('grundstueck', 'Acker', '2018-05-01', '2026-05-01'))],
  ['land10y', statusOf(t('grundstueck', 'Acker', '2016-05-01', '2026-05-01'))],
  ['land10y1d', statusOf(t('grundstueck', 'Acker', '2016-05-01', '2026-05-02'))],
  ['share6m', statusOf(t('wertpapier', 'Aktien ABC', '2026-01-10', '2026-07-10'))],
  ['share2008', statusOf(t('wertpapier', 'Aktien ABC', '2008-12-30', '2026-07-10'))],
  ['legacyCrypto', kindOf({ type: 'wertpapier', description: 'BTC 0.5' })],
  ['legacyShare', kindOf({ type: 'wertpapier', description: 'AAPL 100' })],
  ['unknown', kindOf({ type: 'aktie', description: 'x' })],
  ['limit', `${freigrenzeFor(2023)}/${freigrenzeFor(2024)}`],
]
for (const [k, v] of out) console.log(`${k}=${v}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier664-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "gold sold after six months" "$(P gold6m)" "steuerpflichtig"
assert_eq "gold sold after two years (was taxable: ten years)" "$(P gold2y)" "frei"
assert_eq "sold on the day the year ends: still within it" "$(P day365)" "steuerpflichtig"
assert_eq "a day later" "$(P day366)" "frei"
assert_eq "land sold after eight years" "$(P land8y)" "steuerpflichtig"
assert_eq "land sold on the day the ten years end" "$(P land10y)" "steuerpflichtig"
assert_eq "a day later" "$(P land10y1d)" "frei"
assert_eq "shares bought since 2009: capital income, whatever the period (were taxed here)" "$(P share6m)" "kap"
assert_eq "shares bought before 2009: the old rule, long tax-free" "$(P share2008)" "frei"
assert_eq "a row from before, crypto filed as a security: crypto" "$(P legacyCrypto)" "krypto"
assert_eq "… a share stays a security" "$(P legacyShare)" "wertpapier"
assert_eq "an unknown kind is an other asset" "$(P unknown)" "sonstige"
assert_eq "the limit: 600 up to 2023, 1 000 from 2024" "$(P limit)" "600/1000"

note "=== 2. on the form ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier664-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

put "$(tx sonstige Goldbarren 2024-01-10 1000 2026-07-10 3000)"
assert_eq "gold held two and a half years: saved" "$STATUS" "200"
v1; assert_eq "… not taxable (was 2 000 € on line 41)" "$(field "(d['totals']['vgTotal'], d['vg']['inSpekulationsfrist'])")|$(line 41)" "(0, 0)|0"

put "$(tx wertpapier 'Aktien ABC' 2026-01-10 1000 2026-07-10 6000)"
v1; assert_eq "shares sold after six months: not a private sale (were 5 000 € taxable here)" \
  "$(field "(d['totals']['vgTotal'], d['vg']['countKap'], d['vg']['gainKap'])")|$(line 32)" "(0, 1, 5000)|0"
echo "$BODY" | grep -q "Anlage KAP" && echo "$BODY" | grep -q "1 Geschäft(e) mit seit 2009 angeschafften Wertpapieren" \
  && pass "… and line 32 says where they belong" || fail "no note on line 32"

put "$(tx grundstueck Acker 2018-05-01 100000 2026-05-01 150000)"
v1; assert_eq "land sold after eight years: 50 000 € on line 43 (was a placeholder)" "$(field "d['totals']['vgTotal']")|$(line 43)" "50000|50000"

# a row as it was stored before the four kinds (Tier 665: a row saved since
# then keeps the kind chosen, so the old one is written the way it lies there)
put ""
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c "UPDATE \"Company\" SET settings = jsonb_set(settings::jsonb, '{anlageSO,$Y,transactions}', '[{\"type\":\"wertpapier\",\"description\":\"BTC 0.5\",\"acquisitionDate\":\"2025-09-01\",\"acquisitionCost\":8000,\"saleDate\":\"2026-03-01\",\"salePrice\":12000}]'::jsonb) WHERE id = '$C'" >/dev/null
v1; assert_eq "a row from before — crypto as a security: on line 34 only (lines 32 and 34 had the same sum)" "$(line 32)|$(line 34)|$(field "d['vg']['countKrypto']")" "0|4000|1"

# the year's losses against its gains, then the Freigrenze
put "$(tx krypto ETH 2025-10-01 1000 2026-02-01 4000),$(tx sonstige Goldmuenzen 2025-11-01 5000 2026-03-01 3500)"
v1; V1=$(field "(d['vg']['taxableGain'], d['totals']['vgTotal'])")
assert_eq "3 000 € gain, 1 500 € loss: 1 500 € taxable (the page set no loss off: 3 000)" "$V1" "(1500, 1500)"
v2; assert_eq "the adviser's package computes the same" "$(field "(d['vg']['totalTaxableGain'], d['vg']['vgTotal'])")" "$V1"
put "$(tx krypto ETH 2025-10-01 1000 2026-02-01 4000),$(tx sonstige Goldmuenzen 2025-11-01 5000 2026-03-01 2999)"
v1; assert_eq "net gain 999 €: below the limit, nothing taxable" "$(field "(d['vg']['taxableGain'], d['totals']['vgTotal'])")" "(999, 0)"

# all four kinds at once
put "$(tx krypto BTC 2025-09-01 1000 2026-03-01 3000),$(tx sonstige Gemaelde 2025-12-01 2000 2026-06-01 2500),$(tx grundstueck Acker 2020-01-01 10000 2026-01-15 11000),$(tx wertpapier 'Fonds XY' 2020-01-01 5000 2026-02-01 9000)"
v1; assert_eq "crypto 2 000, another asset 500, land 1 000; the fund not counted" \
  "$(line 34)|$(line 41)|$(line 43)|$(line 32)|$(field "(d['totals']['vgTotal'], d['vg']['countKap'])")" "2000|500|1000|0|(3500, 1)"
AS GET "/api/v1/accounting/anlage-so.pdf?companyId=$C&year=$Y"
curl -sS -o "$TMP/so.pdf" "$API/api/v1/accounting/anlage-so.pdf?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "its PDF" "$(head -c 4 "$TMP/so.pdf")" "%PDF"

put '{"type":"aktie","description":"x","acquisitionDate":"2026-01-01","acquisitionCost":1,"saleDate":"2026-02-01","salePrice":2}'
assert_eq "a kind that is none is refused" "$STATUS" "400"

note "=== 3. what the form says of itself ==="
put "$(tx krypto BTC 2025-09-01 1000 2026-03-01 3000)"; v1
echo "$BODY" | grep -q "noch nicht dem Gesetz entsprechend" && fail "the form still says it is not in line with the law" || pass "the warning of Tier 656 is gone with its cause"
echo "$BODY" | grep -q "Grundstücke sind zehn Jahre" && echo "$BODY" | grep -q "§ 23 Abs. 3 Satz 7" \
  && pass "the closing text names the two periods and the set-off of losses" || fail "the closing text does not explain the rules"
FE="$SCRIPT_DIR/../../frontend"
assert_eq "the form offers the four kinds" "$(grep -c '<option value="\(krypto\|sonstige\|grundstueck\|wertpapier\)">' "$FE/src/app/dashboard/accounting/AnlageSOSection.tsx")" "4"

summary
