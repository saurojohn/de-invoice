#!/bin/bash
# Tier 671 — Anlage N read against §§ 2, 9, 9a EStG
# (gesetze-im-internet.de, 12.10.2026).
#
#   § 9a Satz 1 Nr. 1 a  Arbeitnehmer-Pauschbetrag of 1 230 € (2022: 1 200 €,
#                        2011–2021: 1 000 €), "wenn nicht höhere
#                        Werbungskosten nachgewiesen werden"
#   § 9a Satz 2          … only up to the amount of the wages
#   § 2 Abs. 2 Nr. 2     income from employment = wages less Werbungskosten
#   § 2 Abs. 4           Sonderausgaben and außergewöhnliche Belastungen
#                        reduce the Einkommen, not that income
#
# Before: 1 230 € for every year, ADDED to the expenses entered (2 000 € of
# commuting: 3 230 € deducted), and deducted from no wages at all (a sole
# trader without a job saw "Verlust 1.230 €"). Sonderausgaben and
# außergewöhnliche Belastungen were taken off the income from employment.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-398-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier671-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
put() { AS PUT "/api/v1/accounting/anlage-n/settings?companyId=$C" "$1"; }
n() { AS GET "/api/v1/accounting/anlage-n?companyId=$C&year=$1"; }
T='d["totals"]'
line() { field "[l['amount'] for l in d['werbungskosten'] if l['kennziffer'] == '$1'][0]"; }

note "=== 1. the amounts of the years ==="
cat > "$SCRIPT_DIR/../.tier671-probe.ts" <<'TS'
import { arbeitnehmerPauschbetragFor as p, entfernungspauschaleText as e } from './src/modules/accounting/anlage-n.service'
console.log(`pausch=${[2011, 2021, 2022, 2023, 2026].map(p).join('/')}`)
console.log(`km=${[2020, 2021, 2022, 2025, 2026].map((y) => (e(y).match(/0,3[058]/g) || []).join('+')).join('/')}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier671-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "Arbeitnehmer-Pauschbetrag: 1 000 to 2021, 1 200 in 2022, 1 230 from 2023" "$(P pausch)" "1000/1000/1200/1230/1230"
assert_eq "Entfernungspauschale: 0,30; +0,35 from km 21 in 2021; +0,38 from 2022; 0,38 from 2026" "$(P km)" "0,30/0,30+0,35/0,30+0,38/0,30+0,38/0,38"

note "=== 2. on the form ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier671-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

n 2024
assert_eq "no wages: no Pauschbetrag, no loss (was −1 230 €)" "$(field "($T['werbungskostenTotal'], $T['einkuenfte'])")|$(line 130)" "(0, 0)|0"

put '{"year":2024,"bruttoArbeitslohn":40000,"lohnsteuer":6000}'; n 2024
assert_eq "40 000 € of wages, nothing entered: the Pauschbetrag" "$(line 130)|$(field "($T['werbungskostenTotal'], $T['einkuenfte'])")" "1230|(1230, 38770)"

put '{"year":2024,"bruttoArbeitslohn":40000,"werbungskosten":{"140":2000}}'; n 2024
assert_eq "2 000 € of commuting: 2 000 € of Werbungskosten, not 3 230 €" "$(line 130)|$(line 140)|$(field "($T['werbungskostenTotal'], $T['einkuenfte'])")" "0|2000|(2000, 38000)"
echo "$BODY" | grep -q "Nicht angesetzt: die eingetragenen Werbungskosten (2.000 EUR) sind höher" && pass "… and the line of the Pauschbetrag says why it is 0" || fail "line 130 does not say why it is not applied"

put '{"year":2024,"bruttoArbeitslohn":40000,"werbungskosten":{"140":500,"160":300}}'; n 2024
assert_eq "800 € of expenses: the Pauschbetrag instead — 1 230 €, not 2 030 €" "$(line 130)|$(field "($T['werbungskostenTotal'], $T['werbungskostenNachgewiesen'], $T['einkuenfte'])")" "1230|(1230, 800, 38770)"
echo "$BODY" | grep -q "Angesetzt statt der eingetragenen Werbungskosten (800 EUR)" && pass "… said on the line" || fail "line 130 does not say that it replaces the expenses"

put '{"year":2024,"bruttoArbeitslohn":40000,"werbungskosten":{"140":2000},"sonderausgaben":{"200":3000},"aussergewoehnlicheBelastungen":{"230":500}}'; n 2024
assert_eq "Sonderausgaben 3 000 €, außergewöhnliche Belastungen 500 €: shown, the income from employment stays 38 000 € (was 33 270)" \
  "$(field "($T['sonderausgabenTotal'], $T['aussergewoehnlicheBelastungenTotal'], $T['einkuenfte'])")" "(3000, 500, 38000)"

put '{"year":2023,"bruttoArbeitslohn":800}'; n 2023
assert_eq "wages of 800 €: the Pauschbetrag up to the wages, income 0 (was −430 €)" "$(line 130)|$(field "$T['einkuenfte']")" "800|0"
put '{"year":2023,"bruttoArbeitslohn":800,"werbungskosten":{"170":1500}}'; n 2023
assert_eq "… with 1 500 € of training entered: a loss of 700 € — expenses may exceed the wages" "$(line 130)|$(field "$T['einkuenfte']")" "0|-700"

put '{"year":2021,"bruttoArbeitslohn":30000}'; n 2021
assert_eq "2021: 1 000 € (was 1 230)" "$(line 130)|$(field "$T['einkuenfte']")" "1000|29000"
echo "$BODY" | grep -q "ab dem 21. km 0,35 EUR" && pass "… and the commuting line names 0,35 € from the 21st kilometre" || fail "2021: the commuting line"
put '{"year":2022,"bruttoArbeitslohn":30000}'; n 2022
assert_eq "2022: 1 200 €" "$(line 130)" "1200"
n 2026; echo "$BODY" | grep -q "Entfernungspauschale (0,38 EUR je km einfache Strecke)" && pass "2026: 0,38 € from the first kilometre" || fail "2026: the commuting line"

note "=== 3. what the form says ==="
n 2024
echo "$BODY" | grep -q "27.566" && fail "the stale maximum of 2024 is still named as that of 2026" || pass "no maximum of another year in the notes"
echo "$BODY" | grep -q "ab 1% des Brutto" && fail "außergewöhnliche Belastungen: still „ab 1% des Brutto“" || pass "außergewöhnliche Belastungen: the zumutbare Belastung of § 33 Abs. 3"
echo "$BODY" | grep -q "§ 2 Abs. 4 EStG" && pass "the closing text: Sonderausgaben reduce the Einkommen" || fail "the closing text does not say what is not part of the income"
curl -sS -o "$TMP/n.pdf" "$API/api/v1/accounting/anlage-n.pdf?companyId=$C&year=2024" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the PDF" "$(head -c 4 "$TMP/n.pdf")" "%PDF"
FE="$SCRIPT_DIR/../../frontend"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the page's hints: $lang" || fail "hints old: $lang"
import json,sys
a=json.load(open(sys.argv[1],encoding='utf-8'))['anlageN']
t=a['wkhint']+a['sahint']+a['abhint']
sys.exit(0 if '9a' in a['wkhint'] and '§ 2' in a['sahint'] and '§ 33' in a['abhint'] and '0,30' not in t and '0.30' not in t and '1%' not in t else 1)
PY
done

summary
