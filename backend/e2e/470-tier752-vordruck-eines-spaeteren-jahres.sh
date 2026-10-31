#!/bin/bash
# Tier 752 — a period of a year whose forms nobody has compared yet
#
# The forms USt 1 A and USt 2 A change with the year; the Kennzahlen here are
# those of 2026. From January 2027 on the fill-in list would have headed a
# 2027 period „Vordruck USt 1 A 2026" without a word. It stays the truth about
# where the numbers come from, and a later year now says that it is unchecked.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier752-probe.ts"' EXIT

cat > "$SCRIPT_DIR/../.tier752-probe.ts" <<'TS'
import { formYearNotice, UST_FORM_YEAR } from './src/modules/reports/ust-kennzahlen'
import { generateUstjaAsciiPreview } from './src/modules/reports/elster.service'
const list = (year: number) => generateUstjaAsciiPreview({
  steuernummer: '12/345/67890', companyName: 'Probe GmbH',
  data: { year, periodLabel: String(year), lines: [], counts: { monthsWithData: 0 }, totals: new Proxy({}, { get: () => 0 }) },
} as any)
console.log(`form=${UST_FORM_YEAR}`)
console.log(`same=${formYearNotice(2026)}`)
console.log(`past=${formYearNotice(2025)}`)
console.log(`next=${formYearNotice(2027)}`)
console.log(`list26=${list(2026).split('\n').filter((l) => l.startsWith('# Achtung')).length}`)
console.log(`list27=${list(2027).split('\n').filter((l) => l.startsWith('# Achtung')).join('')}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier752-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "the forms' year is written down once" "$(P form)" "2026"
assert_eq "that year: nothing to say" "$(P same)" "null"
assert_eq "an earlier year: nothing to say" "$(P past)" "null"
assert_eq "the next year says so" "$(P next)" "Kennzahlen nach dem Vordruck 2026; der Vordruck 2027 ist in diesem Programm noch nicht geprüft."
assert_eq "the fill-in list of 2026 has no warning" "$(P list26)" "0"
assert_eq "the one of 2027 has" "$(P list27)" "# Achtung: Kennzahlen nach dem Vordruck 2026; der Vordruck 2027 ist in diesem Programm noch nicht geprüft."

note "=== what the page saves is what it was given ==="
TAG="e2e-470-$(date +%s%N | cut -c1-13)"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier752-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
curl -sS -o "$TMP/data.json" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/compute?companyId=$C&year=$(($(date +%Y) - 1))&month=1"
assert_eq "the computed data carries the field" "$(python3 -c "import json,sys;print('formNotice' in json.load(open(sys.argv[1])))" "$TMP/data.json")" "True"
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d['status']='draft';json.dump(d,open(sys.argv[1],'w'))" "$TMP/data.json"
assert_eq "…and it is saved with it (a field the DTO does not name is a 400)" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/ustva/filings?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" --data @"$TMP/data.json")" "201"
summary
