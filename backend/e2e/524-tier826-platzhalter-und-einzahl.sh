#!/bin/bash
# Tier 826 — what the first-day drill left on the pages, held statically
#
#  1. Messages with placeholders shown unfilled: the invoice list's bulk
#     dunning („Mahnung senden ({count})", „{count} Rechnungen ausgewählt"),
#     the customer page's allocation („{count} Rechnungen bezahlt, {total} €
#     angewendet" — `t(…) || "…".replace(…)` replaced in the fallback only),
#     Anlage SO's empty selection. e2e/i18n_placeholders_check.py finds both
#     forms; none may come back.
#  2. „1 Dokumente": t() takes `key_one` when the count is 1; the singular of
#     the ten messages that count nouns, in German and English (Chinese has
#     none — the same text).
#  3. The bank page wrote amounts as „€ 1.190,00".
# (The bank table's confirm button: Playwright singular-and-bank-row-tier826.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
FE="$SCRIPT_DIR/../../frontend"

note "=== 1. placeholders ==="
OUT=$(python3 "$SCRIPT_DIR/i18n_placeholders_check.py" "$FE")
assert_eq "no message shown with its placeholders unfilled (were 6)" "$(echo "$OUT" | tail -1)" "TOTAL 0"
[[ "$(echo "$OUT" | tail -1)" == "TOTAL 0" ]] || echo "$OUT" | head -8

note "=== 2. the singular ==="
grep -q 'lookup(key + "_one")' "$FE/src/components/useI18n.ts" && pass "t() takes key_one when the count is 1" || fail "t() has no singular"
T524=$(mktemp)
python3 - "$FE" <<'PY' > "$T524" 2>&1
import io, json, sys
fe = sys.argv[1]
keys = ["bankImport.bookPaymentParts", "customerDetail.allocateSuccessCount", "inventory.lowStockCount", "backup.verifyOk",
        "systemErrors.thresholdCurrent", "invoices.bulkSendRangeConfirm", "invoices.bulkMahnungBody", "invoices.sumsLine",
        "directDebit.toast.batchCreated", "time.confirmBill"]
bad = []
for lang in ("de", "en", "zh"):
    d = json.load(io.open(f"{fe}/messages/{lang}.json", encoding="utf-8"))
    for k in keys:
        o = d
        for p in k.split(".")[:-1]:
            o = o[p]
        last = k.split(".")[-1]
        one, many = o.get(last + "_one"), o.get(last)
        if not one:
            bad.append(f"{lang}:{k}_one missing")
        elif lang != "zh" and one == many:
            bad.append(f"{lang}:{k}_one = plural")
print(len(bad), bad[:4])
PY
assert_eq "the ten counting messages have a singular (de, en; zh the same text)" "$(cat "$T524")" "0 []"
rm -f "$T524"
assert_eq "„1 Dokument“ in German" "$(python3 -c "import json;print(json.load(open('$FE/messages/de.json'))['invoices']['sumsLine_one'].split(' ·')[0])")" "{count} Dokument"

note "=== 3. the bank page's amounts ==="
assert_eq "no „€ 1.190,00“ on the bank page (formatMoney: 1.190,00 €)" "$(grep -c '€ {fmtMoney(' "$FE/src/app/dashboard/bank-import/page.tsx")" "0"
grep -q 'data-testid="recon-row-confirm"' "$FE/src/app/dashboard/bank-import/page.tsx" && pass "the Zuordnungen table confirms a suggestion in its row" || fail "no confirm in the Zuordnungen table"
summary
