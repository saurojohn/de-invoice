#!/bin/bash
# Tier 676 — Anlage AUS: a treaty does not mean exemption, and § 8b KStG
# does not hang on a treaty.
#
# § 34c Abs. 6 Satz 2 EStG: "Soweit in einem Abkommen … die Anrechnung einer
# ausländischen Steuer vorgesehen ist …" — by the treaties' usual content
# dividends and interest stay taxable at home with the source tax credited;
# wages, a permanent establishment's profit and income from land are
# exempted. § 8b KStG: a corporation's dividends are left out of its income,
# 5 % count as non-deductible — unless the holding was below 10 % at the
# beginning of the year (Abs. 4).
#
# Before: `hasDba` decided everything. A person's US dividend and US
# interest were "exempt with Progressionsvorbehalt" (and the dividend's tax
# was credited all the same); a GmbH's dividend from a country without a
# treaty was taxed in full whatever the holding, one from a treaty country
# 95 % free "bei Beteiligung ≥ 1%".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TS=$(date +%s%N | cut -c1-13)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier676-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
register() { # company name
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e-402-$TS-$RANDOM@example.test\",\"password\":\"Tier676-e2e\",\"companyName\":\"$1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
e() { # country dba type gross tax [extra json]
  echo "{\"country\":\"$1\",\"countryName\":\"$1\",\"hasDba\":$2,\"incomeType\":\"$3\",\"grossAmount\":$4,\"foreignTaxPaid\":$5,\"description\":\"$3 $1\"${6:+,$6}}"
}
put() { AS PUT "/api/v1/accounting/anlage-aus/settings?companyId=$C" "{\"year\":2025,\"entries\":[$1]}"; }
aus() { AS GET "/api/v1/accounting/anlage-aus?companyId=$C&year=2025"; }
T='d["totals"]'

note "=== 1. the method ==="
cat > "$SCRIPT_DIR/../.tier676-probe.ts" <<'TS'
import { ausMethode as m, ausBehandlung as b } from './src/modules/accounting/anlage-aus.service'
const types = ['dividend', 'interest', 'other', 'employment', 'business', 'selfEmployment', 'agriculture', 'rental'] as const
console.log(`treaty=${types.map((t) => m({ hasDba: true, incomeType: t })[0]).join('')}`)
console.log(`none=${types.map((t) => m({ hasDba: false, incomeType: t })[0]).join('')}`)
console.log(`chosen=${m({ hasDba: true, incomeType: 'rental', methodeGewaehlt: 'anrechnung' })}/${m({ hasDba: true, incomeType: 'dividend', methodeGewaehlt: 'freistellung' })}/${m({ hasDba: false, incomeType: 'rental', methodeGewaehlt: 'freistellung' })}`)
const d = { hasDba: false, incomeType: 'dividend' as const, grossAmount: 2000, foreignTaxPaid: 300 }
const j = (x: unknown) => JSON.stringify(x)
console.log(`kapg10=${j(b({ ...d, beteiligungAb10: true }, true))}`)
console.log(`kapgStreu=${j(b(d, true))}`)
console.log(`person10=${j(b({ ...d, beteiligungAb10: true }, false))}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier676-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "with a treaty: dividends, interest, other income credited; work, business, land exempted" "$(P treaty)" "aaafffff"
assert_eq "without a treaty: everything credited" "$(P none)" "aaaaaaaa"
assert_eq "an entry's own method holds — but there is no exemption without a treaty" "$(P chosen)" "anrechnung/freistellung/anrechnung"
assert_eq "a corporation's dividend, holding of 10 %: 5 % taxable, 95 % left out, no credit — treaty or not" "$(P kapg10)" '{"methode":"paragraph8b","taxable":100,"exempt":1900,"credit":0,"p8b":100}'
assert_eq "… a smaller holding: taxable in full, the tax credited" "$(P kapgStreu)" '{"methode":"anrechnung","taxable":2000,"exempt":0,"credit":300,"p8b":0}'
assert_eq "§ 8b is the corporation's: a person's dividend is credited" "$(P person10)" '{"methode":"anrechnung","taxable":2000,"exempt":0,"credit":300,"p8b":0}'

note "=== 2. a person ==="
register "Tier676 Einzelunternehmen $TS"
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
put "$(e US true dividend 1000 150),$(e US true interest 400 0),$(e CH true employment 50000 9000),$(e BR false dividend 2000 300),$(e ES true rental 6000 1100)"
assert_eq "five entries saved" "$STATUS" "200"
aus
assert_eq "no corporation" "$(field "d['isKapg']")" "False"
assert_eq "exempt by treaty: the Swiss wages and the Spanish rent, 56 000 € (were 57 400 € — the US dividend and interest with them)" "$(field "$T['progressionsvorbehalt']")" "56000"
assert_eq "taxable here: the two dividends and the interest, 3 400 € (were 2 000 €)" "$(field "$T['taxable']")" "3400"
assert_eq "credited: 150 € + 300 € — each on income that is taxed" "$(field "$T['anrechnungsbetrag']")" "450"
assert_eq "each entry says what was applied" "$(field "[x['methode'][0] for x in d['entries']]")" "['a', 'a', 'f', 'a', 'f']"
assert_eq "by country: the US income is taxable, not exempt (was 0 / 1 400)" "$(field "[(c['taxablePortion'], c['exemptPortion']) for c in d['perCountry'] if c['country'] == 'US']")" "[(1400, 0)]"

put "$(e ES true rental 6000 1100 '"methode":"anrechnung"')"
assert_eq "a treaty that credits the rent (as Spain's): the entry says so" "$STATUS" "200"
aus
assert_eq "… taxable with credit, and the choice is kept" "$(field "($T['progressionsvorbehalt'], $T['taxable'], $T['anrechnungsbetrag'], d['entries'][0]['methodeGewaehlt'], d['entries'][0]['methode'])")" "(0, 6000, 1100, 'anrechnung', 'anrechnung')"
put "$(e ES true rental 6000 1100 '"methode":"vielleicht"')"
assert_eq "a method that is none is refused" "$STATUS" "400"

note "=== 3. a GmbH ==="
register "Tier676 Handel $TS GmbH"
put "$(e BR false dividend 2000 300 '"beteiligungAb10":true'),$(e US true dividend 1000 150),$(e CH true business 8000 1200)"
aus
assert_eq "a corporation" "$(field "d['isKapg']")" "True"
assert_eq "the Brazilian dividend, holding of 10 %: § 8b without any treaty — 100 € taxable, 1 900 € left out (was 2 000 € taxable)" \
  "$(field "(d['entries'][0]['methode'], $T['paragraph8b'], $T['paragraph8bFrei'])")" "('paragraph8b', 100, 1900)"
assert_eq "the US dividend, no such holding entered: taxable in full with credit (was 95 % free because of the treaty)" "$(field "d['entries'][1]['methode']")" "anrechnung"
assert_eq "taxable 1 100 €, credited 150 €, the establishment's profit exempt" "$(field "($T['taxable'], $T['anrechnungsbetrag'], $T['progressionsvorbehalt'])")" "(1100, 150, 8000)"
assert_eq "the lines 5, 6, 13, 20" "$(field "[l['amount'] for l in d['lines'] if l['kennziffer'] in ['5', '6', '13', '20']]")" "[8000, 1100, 150, 100]"

note "=== 4. what the form says ==="
echo "$BODY" | grep -q "≥ 1%" && fail "§ 8b „bei Beteiligung ≥ 1%“" || pass "no holding of 1 % for § 8b"
echo "$BODY" | grep -q "mindestens 10 % zu Beginn des Kalenderjahres" && pass "§ 8b: 10 % at the beginning of the year" || fail "§ 8b: the holding is not named"
echo "$BODY" | grep -q "Ein Doppelbesteuerungsabkommen bedeutet nicht Freistellung" && pass "the closing text: a treaty is not an exemption" || fail "the closing text"
curl -sS -o "$TMP/aus.pdf" "$API/api/v1/accounting/anlage-aus.pdf?companyId=$C&year=2025" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the PDF" "$(head -c 4 "$TMP/aus.pdf")" "%PDF"
FE="$SCRIPT_DIR/../../frontend"
SEC="$FE/src/app/dashboard/accounting/AnlageAUSSection.tsx"
grep -q 'data-testid="anlage-aus-methode"' "$SEC" && grep -q 'data-testid="anlage-aus-beteiligung"' "$SEC" && pass "the editor has the method and the holding" || fail "the editor lacks the method or the holding"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the page's texts: $lang" || fail "texts missing or old: $lang"
import json,sys
a=json.load(open(sys.argv[1],encoding='utf-8'))['anlageAus']
ok=all(a.get(k) for k in ('methode','methodeAuto','methodeFreistellung','methodeAnrechnung','beteiligungAb10')) and len(a['applied'])==3 and 'Freistellung' not in a['hasDbaYes'] and a['hasDbaYes']!=a['hasDbaNo']
sys.exit(0 if ok else 1)
PY
done

summary
