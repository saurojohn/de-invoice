#!/bin/bash
# Tier 657 — the tax previews in the language of the interface
#
# §9 item 24: "the accounting page — about 730 German words in the other
# languages". Counted again on 10.10.2026, with the page in Chinese: 1 228
# German words, 1 163 of them from the backend — the previews' line labels,
# their notes and their closing texts are written in German by the services.
#
# The labels are the official designations of German forms: they stay, and
# the interface puts what they mean underneath. Notes and closing texts are
# shown in the language of the interface. frontend/src/lib/tax-form-text.tsx
# looks a text up in frontend/messages/tax-forms/{en,zh}.json by the German
# text with its numbers masked ("#"); a translation names the n-th number as
# {n}. A text without an entry is shown in German — so this spec fails when a
# preview answers with a label, a note or a closing text that has none: who
# changes a sentence in a service finds out here that two translations are
# due. (The Anhang's own paragraphs are a German document, § 244 HGB, and are
# not translated.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-389-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FE="$SCRIPT_DIR/../../frontend"
YEAR=$(TZ=Europe/Berlin date +%Y); TODAY=$(TZ=Europe/Berlin date +%F)

note "=== 1. the dictionaries ==="
python3 - "$FE" > "$TMP/dict.txt" <<'PY'
import io, json, re, sys
fe = sys.argv[1]
en = json.load(io.open(fe + '/messages/tax-forms/en.json', encoding='utf-8'))
zh = json.load(io.open(fe + '/messages/tax-forms/zh.json', encoding='utf-8'))
bad = []
for name, d in (('en', en), ('zh', zh)):
    for k, v in d.items():
        n = k.count('#')
        used = {int(x) for x in re.findall(r'\{(\d+)\}', v)}
        if not v.strip(): bad.append('%s empty: %s' % (name, k[:50]))
        if used and max(used) > n: bad.append('%s names number %d of %d: %s' % (name, max(used), n, k[:50]))
        if used != set(range(1, n + 1)): bad.append('%s leaves a number out: %s' % (name, k[:50]))
        if re.search(r'\d', re.sub(r'\{\d+\}', '', v)) and n: bad.append('%s has a number written out: %s' % (name, k[:50]))
zh_cjk = sum(1 for v in zh.values() if re.search(r'[一-鿿]', v))
print(len(en), len(zh), len(set(en) ^ set(zh)), zh_cjk, len(bad), '; '.join(bad[:3]))
PY
read -r N_EN N_ZH DIFF CJK NBAD FIRST < "$TMP/dict.txt"
[[ "$N_EN" -ge 300 ]] && pass "$N_EN texts in English, $N_ZH in Chinese" || fail "only $N_EN entries"
assert_eq "the two dictionaries have the same texts" "$DIFF" "0"
[[ "$CJK" -ge $((N_ZH - 15)) ]] && pass "the Chinese ones are Chinese ($CJK of $N_ZH; the rest are names like Hebesatz)" || fail "only $CJK of $N_ZH Chinese entries contain Chinese"
assert_eq "every number of a text is named once, by its place — none written out, none left out ($FIRST)" "$NBAD" "0"

note "=== 2. every text the previews answer with has its two translations ==="
# What the page shows from the answers: label, note, disclaimer, title, a
# month's name. Two companies, so that both sets of forms are there — a GmbH
# and a sole trader.
cat > "$TMP/cover.py" <<'PY'
import io, json, re, sys, urllib.request
api, fe, year = sys.argv[1], sys.argv[2], sys.argv[3]
en = json.load(io.open(fe + '/messages/tax-forms/en.json', encoding='utf-8'))
zh = json.load(io.open(fe + '/messages/tax-forms/zh.json', encoding='utf-8'))
FORMS = ['accounting/euer', 'accounting/anlage-s', 'accounting/anlage-v', 'accounting/anlage-kap', 'accounting/anlage-g',
         'accounting/anlage-n', 'accounting/kst1', 'accounting/anlage-r', 'accounting/anlage-kind', 'accounting/anlage-so',
         'accounting/anlage-aus', 'accounting/gewst', 'accounting/bilanz', 'accounting/guv', 'accounting/anhang',
         'accounting/ebilanz', 'ustva/ustja']
SHOWN = {'label', 'note', 'disclaimer', 'monthLabel'}
mask = lambda t: re.sub(r'\d+(?:[.,]\d+)*', '#', t.strip())
seen, missing, forms = set(), {}, 0
def walk(v, key, form):
    if isinstance(v, str):
        if key in SHOWN and re.search(r'[A-Za-zÄÖÜäöü]{3}', v):
            k = mask(v); seen.add(k)
            if k not in en or k not in zh: missing.setdefault(k, form)
    elif isinstance(v, dict):
        for k, x in v.items(): walk(x, k, form)
    elif isinstance(v, list):
        for x in v: walk(x, key, form)
for pair in sys.argv[4:]:
    u, c = pair.split(':')
    for form in FORMS:
        req = urllib.request.Request('%s/api/v1/%s?year=%s&companyId=%s' % (api, form, year, c), headers={'x-user-id': u, 'x-company-id': c})
        try: d = json.load(urllib.request.urlopen(req, timeout=60)); forms += 1
        except Exception: continue
        walk(d, '', form)
print(forms, len(seen), len(missing))
for k, f in list(missing.items())[:8]: print('MISSING', f, '|', k[:150])
PY
reg() { # company name → "user:company"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$RANDOM@example.test\",\"password\":\"Tier657-e2e\",\"companyName\":\"$1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'] + ':' + (d['user'].get('companyId') or d['company']['id']))" 2>/dev/null
}
A=$(reg "$TAG Handel GmbH"); B=$(reg "$TAG Lederwaren")
[[ -n "$A" && -n "$B" ]] && pass "fixture: a GmbH and a sole trader" || { fail "register"; summary; exit 1; }
for P in "$A" "$B"; do
  U=${P%%:*}; C=${P##*:}
  fixture_issuer "$C"
  H=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
  K=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" "${H[@]}" -d '{"name":"Muster GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  I=$(curl -sS -X POST "$API/api/v1/invoices?companyId=$C" "${H[@]}" -d '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":50000,"vatRate":0.19}]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  curl -sS -o /dev/null -X PUT "$API/api/v1/invoices/$I/status?companyId=$C" "${H[@]}" -d '{"status":"sent"}'
  # figures in the annexes of a person's return, so that their lines carry their notes
  curl -sS -o /dev/null -X PUT "$API/api/v1/accounting/anlage-r/settings?companyId=$C" "${H[@]}" -d '{"year":'$YEAR',"drv":12000,"bav":3000,"riester":600,"ruerup":1200,"privat":2400,"sonstige":900,"drvBeginn":2012,"privatAlter":65}'
  curl -sS -o /dev/null -X PUT "$API/api/v1/accounting/gewst/settings?companyId=$C" "${H[@]}" -d '{"year":'$YEAR',"q1":100,"q2":0,"q3":0,"q4":0}'
done
python3 "$TMP/cover.py" "$API" "$FE" "$YEAR" "$A" "$B" > "$TMP/cover.txt"
read -r FORMS SEEN MISSING < <(head -1 "$TMP/cover.txt")
assert_eq "all 17 previews of both companies answered" "$FORMS" "34"
[[ "${SEEN:-0}" -ge 200 ]] && pass "$SEEN different texts on their lines" || fail "only ${SEEN:-0} texts seen"
if [[ "$MISSING" == "0" ]]; then pass "each has an English and a Chinese translation"
else fail "$MISSING texts without a translation: $(grep '^MISSING' "$TMP/cover.txt" | head -4 | tr '\n' ' ')"; fi

note "=== 3. the page uses them ==="
SECTIONS=$(ls "$FE"/src/app/dashboard/accounting/*Section.tsx "$FE"/src/app/dashboard/accounting/EBilanzTab.tsx | wc -l | tr -d ' ')
USING=$(grep -l '@/lib/tax-form-text' "$FE"/src/app/dashboard/accounting/*Section.tsx "$FE"/src/app/dashboard/accounting/EBilanzTab.tsx | wc -l | tr -d ' ')
# the adviser's package and the archive show no form lines
assert_eq "the sections that show form lines go through the dictionary" "$USING of $SECTIONS" "17 of 19"
RAW=$(grep -n '>{[a-zA-Z]*\.label}<\|[^=]{data\.disclaimer}\|>Bezeichnung<\|>Betrag (€)<' "$FE"/src/app/dashboard/accounting/*.tsx | wc -l | tr -d ' ')
assert_eq "no section prints a label, a closing text or a column heading as it came" "$RAW" "0"
grep -q 'data-form-gloss' "$FE/src/lib/tax-form-text.tsx" && grep -q 'maskKey' "$FE/src/lib/tax-form-text.tsx" \
  && pass "a label keeps its German designation and gets its meaning underneath" || fail "tax-form-text.tsx: no gloss"

summary
