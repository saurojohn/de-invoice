#!/bin/bash
# Tier 659 — the German texts that were written into the pages themselves
#
# §9 item 24: "/dashboard/v2, the activity page's action names and parts of
# the import page untranslated". Looked for everywhere instead: about a
# hundred headings, labels, placeholders and hints stood in the markup as
# German text with no key ("Unbezahlte Rechnungen", "Keine Daten verfügbar",
# "Schließen", "Top 5 Kunden YTD", the twelve months of two selects), and
# some seventy messages were passed as German literals to toasts, error
# states and confirmations ("Fehler beim Speichern", "Zahlung wirklich
# löschen?"). In English and Chinese they stayed German.
#
# L("…") keeps the German text where it is and looks it up in
# frontend/messages/literals/{en,zh}.json. This spec holds three things:
#   - no German text node or attribute in the markup that is not looked up;
#   - every text passed to L() has an English and a Chinese entry;
#   - the German literals left elsewhere in the code (messages built with
#     values in them, CSV headings that are German on purpose, label maps)
#     do not become more.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
FE="$SCRIPT_DIR/../../frontend"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 "$SCRIPT_DIR/i18n_literals_check.py" "$FE" > "$TMP/out.txt"
read -r MARKUP CODE USED MISSING N_EN N_ZH KEYDIFF < <(head -1 "$TMP/out.txt")

note "=== 1. the markup ==="
if [[ "$MARKUP" == "0" ]]; then pass "no German text node or attribute that is not looked up (were 105)"
else fail "$MARKUP German texts in the markup: $(grep '^MARKUP' "$TMP/out.txt" | head -4 | tr '\n' ' ')"; fi

note "=== 2. the dictionaries ==="
[[ "$USED" -ge 140 ]] && pass "$USED different texts go through L()" || fail "only $USED texts go through L()"
if [[ "$MISSING" == "0" ]]; then pass "each has an English and a Chinese entry"
else fail "$MISSING without a translation: $(grep '^MISSING' "$TMP/out.txt" | head -4 | tr '\n' ' ')"; fi
assert_eq "the two dictionaries have the same texts ($N_EN / $N_ZH)" "$KEYDIFF" "0"
CJK=$(python3 -c "
import io, json, re, sys
d = json.load(io.open(sys.argv[1], encoding='utf-8'))
print(sum(1 for k, v in d.items() if not re.search(r'[一-鿿]', v)))" "$FE/messages/literals/zh.json")
# names that are the same in every language: Musterstraße 123, Rürup
[[ "$CJK" -le 3 ]] && pass "the Chinese entries are Chinese ($CJK names left as they are)" || fail "$CJK Chinese entries without a Chinese character"

note "=== 3. what is left in the code does not grow ==="
# 120 on 12.10.2026: messages with values in them, the UStVA's CSV headings,
# default texts of e-mails, units that are data ("Stück").
[[ "$CODE" -le 120 ]] && pass "$CODE German literals elsewhere in the code (ceiling 120)" \
  || fail "$CODE German literals in the code, 120 before — the new ones: wrap them in L() and add both translations. $(grep '^CODE' "$TMP/out.txt" | tail -3 | tr '\n' ' ')"

note "=== 4. the lookup ==="
grep -q 'export function L(german: string): string' "$FE/src/components/useI18n.ts" \
  && grep -q 'activeLocale = saved' "$FE/src/components/useI18n.ts" \
  && pass "L() answers in the language the page was switched to" || fail "useI18n.ts: no L() or no language for it"
grep -q 'export function monthShortLabel' "$FE/src/components/useI18n.ts" \
  && ! grep -rq '"Jan", "Feb", "Mär"' "$FE/src/components/RevenueChart.tsx" "$FE/src/app/dashboard/v2/page.tsx" \
  && pass "the charts name the months in the page's language (were \"Mär 26\" everywhere)" || fail "a chart still has the German month names"
# the two pages that list the tokens of a reminder text know the same tokens
for f in mahnungen/templates reminders/templates; do
  for tok in openAmount invoiceTotal issueDateFormatted currency; do
    grep -q "key: \"$tok\"" "$FE/src/app/dashboard/$f/page.tsx" || fail "$f lists no {{$tok}}"
  done
done
pass "both template pages list the open amount, the invoice total, its date and its currency"

summary
