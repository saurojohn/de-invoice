#!/bin/bash
# Tier 868 — no business day, month or year is cut from the UTC clock
#
# Between 00:00 and 01:00 (02:00 in summer) German time the UTC instant is
# still the day before. A date cut from `new Date().toISOString()` is then
# yesterday, and on the 1st last month. Tiers 478, 750 and 756 moved every
# such place onto the German day (common/business-date.ts, frontend
# lib/today.ts); a voucher template's {month}/{year} placeholders were left
# (applied at 00:30 on 1 November: „Miete 10/2026“). This guards the whole
# code: no `new Date().toISOString()` (or `Date.now()`'s) cut to a day, month or
# year, in the backend and the frontend.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
HITS=$(cd "$ROOT" && grep -rnE \
  "(new Date\(\)|new Date\(Date\.now\(\)\))\.toISOString\(\)\.(slice|substring)\((0, ?(4|7|10)|5, ?7|8, ?10)\)|(new Date\(\)|new Date\(Date\.now\(\)\))\.toISOString\(\)\.split\(['\"]T['\"]\)|\|\| ?new Date\(\)\.toISOString\(\)\)\.(slice|substring)" \
  backend/src frontend/src --include='*.ts' --include='*.tsx' | grep -v '\.spec\.ts:')
assert_eq "no day, month or year cut from the UTC clock (Tier 868: voucher-template.service.ts had two)" "${HITS:-none}" "none"
assert_eq "the voucher template's placeholders take the German day" \
  "$(grep -c 'const day = applyData.date || businessTodayIso();' "$ROOT/backend/src/modules/accounting/voucher-template.service.ts")" "1"
summary
