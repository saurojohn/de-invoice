#!/bin/bash
# Tier 776 — an ECB answer that is no rate table is not kept as „no rate"
#
# Found in the audit of what the process keeps between requests (after Tier
# 775): the rate of a settled day is kept until the process restarts, and an
# answer that parsed to nothing — a maintenance page with status 200 — was kept
# as „no rate on that day". It is a failure now, asked again the next time.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
OUT=$(cd "$SCRIPT_DIR/.." && npx ts-node --transpile-only scripts/probe-ecb-unreadable.ts 2>&1 | tail -1)
field() { printf '%s' "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])" 2>/dev/null || echo "probe: $OUT"; }
assert_eq "a maintenance page is 'not available now'" "$(field first)" "unavailable"
assert_eq "and the next request has the day's rate" "$(field second)" "1.0880"
summary
