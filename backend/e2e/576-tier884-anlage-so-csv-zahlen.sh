#!/bin/bash
# Tier 884 — the Anlage SO import reads amounts and separators as they come
#
# Found after Tier 882 (looking for the other number readers): the private
# sales import stripped every point before reading an amount. A broker
# export's „1500.00“ / „1750.50“ became 150 000 / 175 050 — a gain of 250,50 €
# was 25 050 € on the Anlage SO, far above the 1 000 € Freigrenze. And only
# „,“ separated the columns: a German Excel file („;“) and cells pasted from
# Excel (tabs) both gave „CSV-Spalte "description" fehlt“.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-576-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier884-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
preview() {
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'year':2026,'csv':sys.argv[2],'previewOnly':True}))" "$C" "$1")
  curl -sS -X POST "$API/api/v1/accounting/anlage-so/import-csv?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'preview' not in d: print(d.get('message')); sys.exit()
print(' | '.join(('%s %s/%s' % (r['transaction']['description'], r['transaction']['acquisitionCost'], r['transaction']['salePrice'])) if r['ok'] else ('%s: %s' % (r['transaction']['description'], '; '.join(r['warnings']))) for r in d['preview']))"
}
H="type,description,acquisitionDate,acquisitionCost,saleDate,salePrice"

note "=== 1. a broker export: „,“ and points ==="
assert_eq "1500.00 / 1750.50 as written (was: 150000 / 175050)" \
  "$(preview "$(printf '%s\nwertpapier,ACME Aktie,2026-01-10,1500.00,2026-03-15,1750.50\n' "$H")")" "ACME Aktie 1500/1750.5"

note "=== 2. German Excel: „;“ and commas ==="
assert_eq "„;“ is read; 1.500,00 / 1.750,50 (was: column description missing)" \
  "$(preview "$(printf '%s\nwertpapier;BETA Aktie;10.01.2026;1.500,00;15.03.2026;1.750,50\n' "$(echo "$H" | tr , ';')")")" "BETA Aktie 1500/1750.5"

note "=== 3. cells pasted from Excel: tabs ==="
assert_eq "tabs are read (was: column description missing)" \
  "$(preview "$(printf '%s\nwertpapier\tGAMMA Aktie\t10.01.2026\t2000\t15.03.2026\t2100,25\n' "$(echo "$H" | tr , '\t')")")" "GAMMA Aktie 2000/2100.25"

note "=== 4. an amount that could be either ==="
OUT=$(preview "$(printf '%s\nwertpapier;DELTA Aktie;10.01.2026;1.500;15.03.2026;1.600\n' "$(echo "$H" | tr , ';')")")
assert_eq "„1.500“ is not guessed: the row is marked, not ok" "$(echo "$OUT" | grep -c "^DELTA Aktie: row 1: acquisitionCost ungültig")" "1"

note "=== 5. quoted German amounts in a „,“ file: as before ==="
assert_eq "\"1.500,00\" in quotes" \
  "$(preview "$(printf '%s\nwertpapier,EPS Aktie,10.01.2026,"1.500,00",15.03.2026,"1.750,50"\n' "$H")")" "EPS Aktie 1500/1750.5"
summary
