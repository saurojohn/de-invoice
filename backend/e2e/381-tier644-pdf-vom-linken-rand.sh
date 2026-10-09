#!/bin/bash
# Tier 644 — the tax previews as PDFs: a line starts at the left margin, and
# in characters the font has
#
# The UStVA PDF was opened to look at a line added to its footer, and the
# footer ran off the page. So did every line written without a position:
# pdfkit leaves its text cursor where the last table cell began, in the amount
# column, and `doc.text('3. Abziehbare Vorsteuer')` was set there, 90 points
# wide — "Steuer als L / eistungsem / pfänger". Measured on all nineteen PDFs
# of the accounting page, by the x at which each line of text starts: eleven
# had lines starting at the left edge of a right-hand column (KSt 1: 30,
# Anlage G: 26, GewSt: 21, UStJA: 16, …), their summaries in fragments, their
# closing notes cut at the page edge.
# And the built-in fonts print WinAnsi only: "↳" came out as "!³", "✓" as
# "'", the minus sign as a quotation mark ("Aktiva " sonstige Passiva").
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-381-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
YEAR=$(TZ=Europe/Berlin date +%Y); TODAY=$(TZ=Europe/Berlin date +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier644-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Muster GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'; I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an issued invoice, so the forms have figures" "$STATUS" "200"

note "=== 1. where the lines start ==="
# The x of every line of text ("1 0 0 1 x y Tm"). An amount is set flush right
# and starts wherever its width leaves it; a line that starts at a whole
# number of points in the right half of the page starts at a column's left
# edge — a heading or a note that was left in the amount column.
scan() { python3 - "$1" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
xs = []
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
    try: t = zlib.decompress(m.group(1))
    except Exception: continue
    xs += [float(x) for x in re.findall(rb'1 0 0 1 ([0-9.]+) [0-9.]+ Tm', t)]
print(d[:4].decode('latin1'), len(xs) > 20, sum(1 for x in xs if x >= 250 and abs(x - round(x)) < 0.01))
PY
}
for form in accounting/euer accounting/anlage-s accounting/anlage-v accounting/anlage-kap accounting/anlage-g accounting/anlage-n \
            accounting/kst1 accounting/anlage-r accounting/anlage-kind accounting/anlage-so accounting/anlage-aus accounting/gewst \
            accounting/anhang ustva/ustja; do
  name=${form#*/}
  code=$(curl -sS -o "$TMP/$name.pdf" -w '%{http_code}' "$API/api/v1/$form.pdf?companyId=$C&year=$YEAR" -H "x-user-id: $U" -H "x-company-id: $C")
  assert_eq "$name.pdf: a PDF with text, and no line starts at the left edge of a right-hand column" "$code $(scan "$TMP/$name.pdf")" "200 %PDF True 0"
done

note "=== 2. every tax preview goes through it, and the signs are printable ==="
cd "$SCRIPT_DIR/.."
BARE=$(grep -rln "new PDFDocument(" src/modules/accounting src/modules/reports --include='*.ts' | while read -r f; do
  [ "$(grep -c "new PDFDocument(" "$f")" = "$(grep -c "flowFromLeft(new PDFDocument(" "$f")" ] || echo "$f"; done)
assert_eq "every PDF of the accounting and the report modules is made with flowFromLeft()" "${BARE:-none}" "none"
# a source that builds a PDF and has one of the signs in a text must print through the translation
cat > "$TMP/unsafe.py" <<'PY'
import glob, io, re
signs = '−↳✓✔✗✘⚠→≥≤≠ΣΔ'
out = []
for p in sorted(glob.glob('src/**/*.ts', recursive=True)):
    s = io.open(p, encoding='utf-8').read()
    if 'new PDFDocument(' not in s or p.endswith('common/pdf-flow.ts'): continue
    code = '\n'.join(l for l in s.split('\n') if not l.strip().startswith(('//', '*', '/*')))
    lits = ''.join(re.findall(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`(?:[^`\\]|\\.)*`", code))
    if any(c in lits for c in signs) and 'flowFromLeft(' not in s and 'printableText(' not in s: out.append(p)
print(' '.join(out) or 'none')
PY
UNSAFE=$(python3 "$TMP/unsafe.py")
assert_eq "…and no PDF source uses a sign the font lacks without the translation" "$UNSAFE" "none"
PROBE=$(npx ts-node -T -e "
import { printable } from './src/common/pdf-flow'
console.log(JSON.stringify(printable('↳ Aktiva − Passiva ✓ ok ⚠ x ≥ 1 Σ a → b ≠ c')))" 2>&1 | tail -1)
assert_eq "the signs in characters of the font (was: '!³', a quotation mark for the minus, an apostrophe for the tick)" \
  "$PROBE" "\"› Aktiva – Passiva ok Achtung: x >= 1 Summe a -> b ungleich c\""
summary
