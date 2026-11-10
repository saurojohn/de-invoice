#!/bin/bash
# Tier 827 — the app asks with dialogs of its own
#
# 58 `confirm()`, 6 `prompt()` and an `alert()` used the browser's dialogs.
# Those offer „Diese Seite daran hindern, weitere Dialogfelder zu erstellen":
# once ticked, every later `confirm()` answers false and every `prompt()` null
# at once — „Löschen", „Stornieren", „Bestätigen" did nothing, with no word
# why. They also named the host and ignored the page's language and dark
# mode. components/ConfirmDialog: `askConfirm()` and `askText()`; the alert
# is a toast. None of the browser's may come back.
# (Behaviour: Playwright confirm-dialog-tier827 — Escape, „Abbrechen", beside
# the box, „OK"; the converted specs answer the app's dialog.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
FE="$SCRIPT_DIR/../../frontend"

LEFT=$(grep -rnE "(window\.)?\b(confirm|prompt|alert)\(" "$FE/src" | grep -vE "^[^:]+:[0-9]+:\s*(//|\*|/\*)" | grep -vE "askConfirm\(|askText\(" | grep -vE "//.*\b(confirm|prompt|alert)\(" || true)
assert_eq "no browser confirm() / prompt() / alert() in the pages (were 65)" "$(echo -n "$LEFT" | grep -c . || true)" "0"
[[ -n "$LEFT" ]] && echo "$LEFT" | head -5
USES=$(grep -rhoE "\bask(Confirm|Text)\(" "$FE/src" | wc -l | tr -d ' ')
[[ "$USES" -ge 64 ]] && pass "$USES questions go through the app's dialog" || fail "only $USES calls of askConfirm / askText"
D="$FE/src/components/ConfirmDialog.tsx"
grep -q 'e.key === "Escape"' "$D" && grep -q 'role="alertdialog"' "$D" && grep -q 'aria-modal="true"' "$D" \
  && pass "the dialog: Escape cancels, an alertdialog, modal" || fail "ConfirmDialog lacks Escape / role / aria-modal"
grep -q 'before?.focus' "$D" && pass "the focus goes back to what asked" || fail "the focus is not given back"
assert_eq "no spec waits for a browser confirm the app no longer shows (prompt / confirm handlers left)" \
  "$(grep -rlE "d\.accept\('119\.00'\)|accept\(\`\\\$\{year\}-02-10\`\)" "$FE/e2e" | wc -l | tr -d ' ')" "0"
summary
