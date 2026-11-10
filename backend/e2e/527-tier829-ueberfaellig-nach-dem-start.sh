#!/bin/bash
# Tier 829 — „überfällig" after the server starts, not only at night
#
# The status `overdue` is set by a job at 00:05 (Tier 710). On the production
# images, invoices entered on the first day with their due date passed stood
# as „Versendet" — the invoice page said „8 Tage überfällig", the customer
# page 3 overdue, the dashboard „Überfällige Rechnungen 0 ✓" — until the
# night; after every restart the same. In production the job also runs a
# minute after the start (rehearsed: 3 invoices marked at 19:45:09, the
# server up at 19:44:08). Not in the test suites — their server starts on a
# database of earlier runs and they read the statuses they set — so this
# spec holds the code; the job's body is spec 405's / Tier 710's.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
F="$SCRIPT_DIR/../src/modules/invoice/overdue-status.scheduler.ts"
grep -q "implements OnApplicationBootstrap" "$F" && grep -q "onApplicationBootstrap()" "$F" \
  && pass "the overdue job has a start hook" || fail "no start hook in overdue-status.scheduler.ts"
grep -q "process.env.NODE_ENV !== 'production' || process.env.DISABLE_CRON === '1'" "$F" \
  && pass "…in production only, and not with DISABLE_CRON=1" || fail "the start hook is not limited to production"
grep -q "}, 60_000)" "$F" && grep -q "timer.unref" "$F" \
  && pass "a minute after the start, without holding the process open" || fail "the start hook's timer"
grep -q "this.health.wrap('invoice-overdue-status'" "$F" \
  && pass "recorded on System-Gesundheit as the nightly run is" || fail "the start run is not recorded"
summary
