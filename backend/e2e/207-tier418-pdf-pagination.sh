#!/bin/bash
# Tier 418 — a long invoice breaks across pages instead of exploding
#
# The item table had no page break. A row below the page's bottom margin made
# PDFKit start a new page for each of its cells, so — measured — an invoice
# with 25 items was a 26-page PDF and one with 40 items 116 pages, mostly
# blank, with the totals and bank details on the last page. Every page that
# carried a number said "Seite 1".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-207-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier418-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)

WORK=$(mktemp -d)
# pdf_facts file n → "pages|rows found|each row once|labels|totals page"
pdf_facts() {
  python3 - "$1" "$2" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); n = int(sys.argv[2])
m = re.search(rb'/Type /Pages[^>]*?/Count (\d+)', d, re.S)
pages = int(m.group(1)) if m else -1
page = 0; rows = []; labels = []; totals_page = None
for mm in re.finditer(rb'/Filter /FlateDecode[^>]*>>\s*stream\r?\n(.*?)\r?\nendstream', d, re.DOTALL):
    try: dec = zlib.decompress(mm.group(1))
    except Exception: continue
    if b'TJ' not in dec: continue
    page += 1
    for line in dec.split(b'\n'):
        hx = re.findall(rb'<([0-9A-Fa-f]+)>', line)
        if not hx: continue
        txt = b''.join(bytes.fromhex(h.decode()) for h in hx).decode('latin-1', 'ignore')
        if txt.startswith('Position '): rows.append(txt)
        if txt.startswith('Seite '): labels.append(txt)
        if txt.startswith('Gesamtbetrag:'): totals_page = page
want = ['Position %03d' % i for i in range(1, n + 1)]
print(f"{pages}|{len(rows)}|{sorted(rows) == want}|{';'.join(labels)}|{totals_page}")
PY
}
invoice() { # n → pdf path
  local items
  items=$(python3 -c "import json,sys;print(json.dumps([{'description':'Position %03d'%i,'quantity':1,'unit':'Stk','unitPrice':10,'vatRate':0.19} for i in range(1,int(sys.argv[1])+1)]))" "$1")
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":$items}"
  local id; id=$(json_field "$BODY" id)
  curl -sS -o "$WORK/$1.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$id/pdf?companyId=$C"
  echo "$id"
}

note "=== 1. a one-page invoice stays one page ==="
invoice 5 >/dev/null
IFS='|' read -r P R ONCE L T <<<"$(pdf_facts "$WORK/5.pdf" 5)"
assert_eq "5 items: 1 page" "$P" "1"
assert_eq "5 items: label 'Seite 1 von 1'" "$L" "Seite 1 von 1"

note "=== 2. 25 items: 2 pages (was 26) ==="
invoice 25 >/dev/null
IFS='|' read -r P R ONCE L T <<<"$(pdf_facts "$WORK/25.pdf" 25)"
assert_eq "25 items: 2 pages" "$P" "2"
assert_eq "every item row printed exactly once" "$ONCE" "True"
assert_eq "labels 'Seite 1 von 2', 'Seite 2 von 2' (every page said 'Seite 1')" "$L" "Seite 1 von 2;Seite 2 von 2"
assert_eq "totals on the last page" "$T" "2"

note "=== 3. 100 items: 4 pages (40 items were 116) ==="
ID100=$(invoice 100)
IFS='|' read -r P R ONCE L T <<<"$(pdf_facts "$WORK/100.pdf" 100)"
assert_eq "100 items: 4 pages" "$P" "4"
assert_eq "all 100 rows, once each" "$ONCE" "True"
assert_eq "4 page labels" "$(tr ';' '\n' <<<"$L" | grep -c 'von 4')" "4"
assert_eq "totals on page 4" "$T" "4"
# the column headers are repeated on each page
HDRS=$(python3 - "$WORK/100.pdf" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); n = 0
for mm in re.finditer(rb'/Filter /FlateDecode[^>]*>>\s*stream\r?\n(.*?)\r?\nendstream', d, re.DOTALL):
    try: dec = zlib.decompress(mm.group(1))
    except Exception: continue
    if b'TJ' not in dec: continue
    txt = b''.join(bytes.fromhex(h.decode()) for h in re.findall(rb'<([0-9A-Fa-f]+)>', dec)).decode('latin-1', 'ignore')
    n += 'Einzelpreis' in txt
print(n)
PY
)
assert_eq "column headers on all 4 pages" "$HDRS" "4"

note "=== 4. the ZUGFeRD PDF of a long invoice is the same document ==="
curl -sS -o "$WORK/z.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$ID100/zugferd?companyId=$C"
IFS='|' read -r P R ONCE L T <<<"$(pdf_facts "$WORK/z.pdf" 100)"
assert_eq "ZUGFeRD: 4 pages" "$P" "4"

rm -rf "$WORK"
summary; exit $?
