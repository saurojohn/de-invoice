#!/bin/bash
# Tier 755 — a form whose effect derives a field writes on the current state
#
# The UStVA expense form sets VAT and gross in an effect after a keystroke. A
# change right behind it, `setExForm({ ...exForm, … })`, spread this render's
# state, wrote the old amounts back and the save was refused: net 1 000, VAT
# 0,19. On the production build it failed 3 times in 25, under `next dev` the
# renders leave no such gap, so CI (ts-node and next dev) never saw it. It
# cannot be forced in a test, so this holds the way the two forms are written.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
APP="$SCRIPT_DIR/../../frontend/src/app/dashboard"
assert_eq "the expense form: no change spreads this render's state" "$(grep -c 'setExForm({ \.\.\.exForm' "$APP/accounting/ustva/page.tsx")" "0"
assert_eq "the time form: nor there (an effect sets the default rate)" "$(grep -c 'setForm({ \.\.\.form' "$APP/time/page.tsx")" "0"
assert_eq "…they patch the current one" "$(grep -c 'setExForm((f) => ({ \.\.\.f, \.\.\.patch }))' "$APP/accounting/ustva/page.tsx")/$(grep -c 'setForm((f) => ({ \.\.\.f, \.\.\.patch }))' "$APP/time/page.tsx")" "1/1"
summary
