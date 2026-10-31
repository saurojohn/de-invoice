#!/bin/bash
# Tier 753 — a half year whose Basiszinssatz is not in the table yet
#
# The rate changes on 1 January and 1 July and lives in a table in the code.
# From the day a half year begins without its rate, `basiszinssatzAt` uses the
# last one, and a dunning letter demands interest at it without a word. The
# amounts stay as they are (a Mahnung is not held up); the operator and the
# person sending a reminder are told.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier753-probe.ts"' EXIT

cat > "$SCRIPT_DIR/../.tier753-probe.ts" <<'TS'
import { basiszinssatzAt, basiszinssatzWarning } from './src/modules/reminder/basiszinssatz'
const at = (iso: string) => basiszinssatzWarning(new Date(iso))
console.log(`known=${at('2026-10-31T10:00:00.000Z')}`)
console.log(`lastDay=${at('2026-12-31T22:59:00.000Z')}`)
console.log(`midnight=${at('2026-12-31T23:30:00.000Z')}`)
console.log(`later=${at('2027-05-20T10:00:00.000Z')}`)
console.log(`summer=${at('2027-07-01T10:00:00.000Z')}`)
console.log(`rate=${basiszinssatzAt(new Date('2027-01-15T00:00:00.000Z'))}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier753-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
MISSING="Der Basiszinssatz ab 01.01.2027 ist noch nicht hinterlegt. Verzugszinsen werden mit dem letzten bekannten Satz (1,52 %) berechnet."
assert_eq "the half year's rate is in the table: nothing to say" "$(P known)" "null"
assert_eq "…up to 23:59 on 31.12. in Germany" "$(P lastDay)" "null"
assert_eq "00:30 on 01.01. in Germany, 23:30 UTC: it says so" "$(P midnight)" "$MISSING"
assert_eq "…through the half year" "$(P later)" "$MISSING"
assert_eq "the next half year names itself" "$(P summer | grep -o 'ab 01.07.2027')" "ab 01.07.2027"
assert_eq "the interest still uses the last rate" "$(P rate)" "1.52"

note "=== the routes ==="
login
assert_eq "system health: a list, empty while the rate is known" \
  "$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" "$API/api/v1/admin/cron-health/warnings")" "[]"
summary
