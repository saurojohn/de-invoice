#!/bin/bash
# Tier 672 — Anlage Kind read against §§ 31, 32, 66 EStG
# (gesetze-im-internet.de, 12.10.2026).
#
#   § 66 Abs. 1   Kindergeld "beträgt monatlich für jedes Kind 259 Euro"
#   § 32 Abs. 6   3 414 € + 1 464 € for each parent and year; doubled for
#                 spouses assessed together; a twelfth less per month
#   § 32 Abs. 3   counted from the month of birth, while not yet 18 at the
#                 beginning of the month; Abs. 4: of age only under
#                 conditions, not beyond 25
#   § 31          the Freibeträge or the Kindergeld — whichever is better
#
# Before: the month's 250 € was the year's Kindergeld; 6 612 € (two parents,
# 2024) + 1 320 € (one parent, the amount up to 2020) for every year; every
# child of the list counted in full — a 35-year-old, a child born in
# August, one marked as not entitled; and "Net (FB − KG)".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-399-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier672-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
kid() { echo "{\"name\":\"$1\",\"birthDate\":\"$2\",\"kindergeldEligible\":${3:-true}}"; }
put() { AS PUT "/api/v1/accounting/anlage-kind/settings?companyId=$C" "{\"year\":$1,\"kinder\":[$2]}"; }
k() { AS GET "/api/v1/accounting/anlage-kind?companyId=$C&year=$1"; }
line() { field "[l['amount'] for l in d['einnahmen'] + d['ausgaben'] if l['kennziffer'] == '$1'][0]"; }

note "=== 1. the rules themselves ==="
cat > "$SCRIPT_DIR/../.tier672-probe.ts" <<'TS'
import { kindMonate as m, kindSaetzeFor as s } from './src/modules/accounting/anlage-kind.service'
const n = (b: string, y: number, ok = true) => { const r = m(b, y, ok); return `${r.monate.length}${r.grund ? ':' + r.grund : ''}` }
const out: Array<[string, unknown]> = [
  ['wholeYear', n('2015-03-10', 2024)],
  ['bornAugust', n('2024-08-20', 2024)],
  ['bornNextYear', n('2025-02-01', 2024)],
  ['turns18on15June', n('2006-06-15', 2024)],
  ['turns18on1June', n('2006-06-01', 2024)],
  ['twenty', n('2004-01-10', 2024)],
  ['turns25on15March', n('1999-03-15', 2024)],
  ['thirtyFive', n('1989-01-05', 2024)],
  ['notEntitled', n('2012-06-01', 2024, false)],
  ['noDate', n('', 2024)],
  ['saetze', [2021, 2022, 2023, 2024, 2025, 2026].map((y) => { const r = s(y); return `${r.kinderfreibetrag}+${r.bea}/${r.kindergeld[0]}` }).join(' ')],
  ['rank2022', s(2022).kindergeld.join('/')],
  ['stand', `${s(2019).stand}/${s(2030).stand}`],
]
for (const [key, v] of out) console.log(`${key}=${v}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier672-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "a child of nine: twelve months" "$(P wholeYear)" "12"
assert_eq "born on 20 August: August to December" "$(P bornAugust)" "5"
assert_eq "born the year after: not counted" "$(P bornNextYear)" "0:nochNichtGeboren"
assert_eq "18 on 15 June: June still counts as a minor's — then of age" "$(P turns18on15June)" "12:volljaehrigOhneNachweis"
assert_eq "20 years old, entered as entitled: counted, proof needed" "$(P twenty)" "12:volljaehrigOhneNachweis"
assert_eq "25 on 15 March: January to March" "$(P turns25on15March)" "3:volljaehrigOhneNachweis"
assert_eq "35 years old: not counted" "$(P thirtyFive)" "0:ueber25"
assert_eq "entered as not entitled: not counted" "$(P notEntitled)" "0:keinAnspruch"
assert_eq "no date of birth: not counted" "$(P noDate)" "0:geburtsdatum"
assert_eq "per parent and year / a month: 2021 … 2026" "$(P saetze)" "2730+1464/219 2810+1464/219 3012+1464/250 3306+1464/250 3336+1464/255 3414+1464/259"
assert_eq "2022 by the child's rank" "$(P rank2022)" "219/219/225/250"
assert_eq "a year outside the table takes the nearest, and says which" "$(P stand)" "2021/2026"

note "=== 2. on the form ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier672-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

put 2024 "$(kid Anna 2015-03-10),$(kid Ben 2024-08-20),$(kid Clara 1989-01-05),$(kid David 2012-06-01 false)"
assert_eq "four children saved" "$STATUS" "200"
k 2024
assert_eq "two of them count: Anna twelve months, Ben five (were: four, in full)" \
  "$(field "(d['totals']['anzahlKinder'], d['totals']['kindermonate'], [(c['name'], c['monate'], c['grund']) for c in d['kinder']])")" \
  "(2, 17, [('Anna', 12, None), ('Ben', 5, None), ('Clara', 0, 'ueber25'), ('David', 0, 'keinAnspruch')])"
assert_eq "Kindergeld: 17 months of 250 € = 4 250 € (was 1 000 € — a month's amount as the year's)" "$(line 6600)|$(field "d['totals']['kindergeldTotal']")" "4250|4250"
assert_eq "one parent: 3 306 € and 1 464 € by 17 twelfths (were 26 448 € and 5 280 €)" "$(line 6610)|$(line 6620)|$(field "d['totals']['freibetragTotal']")" "4683.5|2074|6757.5"
assert_eq "there is no „net“ of a payment and a deduction" "$(field "'net' in d['totals']")" "False"
echo "$BODY" | grep -q "250 EUR je Kind und Monat" && echo "$BODY" | grep -q "3.306 EUR je Elternteil und Jahr" && echo "$BODY" | grep -q "1.464 EUR je Elternteil und Jahr" \
  && pass "the lines name the amounts of 2024, a month and per parent" || fail "the lines do not name the amounts of the year"
echo "$BODY" | grep -q "§ 31 Satz 4 EStG" && pass "the closing text: Kindergeld or Freibeträge, not both" || fail "the closing text does not say that it is one or the other"

AS PUT "/api/v1/accounting/zusammenveranlagung?companyId=$C" '{"zusammenveranlagung":true}'
k 2024
assert_eq "assessed together: the Freibeträge double, the Kindergeld does not" "$(line 6600)|$(line 6610)|$(line 6620)|$(field "d['saetze']['zusammenveranlagung']")" "4250|9367|4148|True"
AS PUT "/api/v1/accounting/zusammenveranlagung?companyId=$C" '{"zusammenveranlagung":false}'

put 2022 "$(kid A 2010-01-01),$(kid B 2012-01-01),$(kid Cc 2014-01-01),$(kid D 2016-01-01)"; k 2022
assert_eq "2022, four children: 219 + 219 + 225 + 250 € a month" "$(line 6600)" "10956"
put 2026 "$(kid Anna 2015-03-10)"; k 2026
assert_eq "2026: 259 € a month, 3 414 € + 1 464 €" "$(line 6600)|$(line 6610)|$(line 6620)" "3108|3414|1464"
put 2028 "$(kid Anna 2015-03-10)"; k 2028
echo "$BODY" | grep -q "Hinterlegt sind die Beträge von 2026" && pass "2028: the amounts of 2026, and the form says so" || fail "2028: no word that the amounts are of another year"

curl -sS -o "$TMP/kind.pdf" "$API/api/v1/accounting/anlage-kind.pdf?companyId=$C&year=2024" -H "x-user-id: $U" -H "x-company-id: $C"
pdf_contains "5 Monate" "$TMP/kind.pdf" && pdf_contains "nicht ber" "$TMP/kind.pdf" && pdf_contains "nicht beides" "$TMP/kind.pdf" \
  && pass "the PDF: each child's months or the reason, and one or the other" || fail "the PDF does not show the months"

note "=== 3. on the page ==="
FE="$SCRIPT_DIR/../../frontend"
SEC="$FE/src/app/dashboard/accounting/AnlageKindSection.tsx"
grep -q "Net (FB - KG)" "$SEC" && fail "the page still shows „Net (FB - KG)“" || pass "no „Net (FB - KG)“ on the page"
grep -q 'data-testid="anlage-kind-zusammen"' "$SEC" && pass "the page has the choice of joint assessment" || fail "no choice on the page"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the page's texts: $lang" || fail "texts missing or old: $lang"
import json,sys
a=json.load(open(sys.argv[1],encoding='utf-8'))['anlageKind']
t=a['subtitle']+a['betragHint']
ok=all(a.get(x) for x in ('zusammenveranlagung','kinderOfYear','summaryLine','guenstiger','monate')) and len(a['grund'])==5 and '7.932' not in t and '1.000' not in t and '{n}' in a['monate']
sys.exit(0 if ok else 1)
PY
done

summary
