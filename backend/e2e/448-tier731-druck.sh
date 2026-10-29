#!/bin/bash
# Tier 731 — printing an invoice
#
# The owner, 24.10.2026: „发票打印功能是否完善？“ Measured on the printed PDF:
#   - the address 17.6 mm from the left — in a DL window envelope (window 20 mm
#     from the left, DIN 5008 Form B: writing from 25 mm) the first characters
#     of each line could sit behind the window's edge; no fold marks, no hole
#     mark; the customer's contact person (stored, used by the reminder) left
#     out of the address;
#   - a description over two lines ran over the row's line into the next row
#     (every row 24 pt high);
#   - the second sheet said only „Seite 2 von 2“ — no invoice, no customer;
#   - printing many: a ZIP to unpack, every file opened and printed by itself.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-448-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
reg() { # → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier731-e2e\",\"companyName\":\"$1 Werkstatt\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
read -r U2 C2 < <(reg "$TAG-b")
[[ -n "${C:-}" && -n "${C2:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
pos() { node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$1" --pos; }
# P python-expression over the positions of $1 (pages: [[{s,x,y,size}]])
P() { pos "$1" | python3 -c "import json,sys;pages=json.load(sys.stdin);first=lambda t,p=0:next((r for r in pages[p] if r['s']==t),None);print($2)"; }
pages() { node -e "require('pdf-lib').PDFDocument.load(require('fs').readFileSync(process.argv[1])).then(d=>console.log(d.getPageCount()))" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","address":{"street":"Hauptstr. 5","postalCode":"10115","city":"Berlin","country":"DE"},"bankInfo":{"bankName":"Testbank","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
assert_eq "fixture: the company" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Beispiel Kunde AG","type":"business","contact":{"name":"Frau Erika Mustermann"},"address":{"street":"Ringstraße 22","postalCode":"80331","city":"München","country":"DE"}}'
KB=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Max Privat","type":"individual","contact":{"name":"Max Privat"},"address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
KP=$(json_field "$BODY" id)
ITEMS=$(python3 -c "import json;print(json.dumps([{'description':f'Position {i}: Ledertasche Modell Berlin mit Gravur','quantity':1,'unit':'Stk','unitPrice':10+i,'vatRate':0.19} for i in range(1,31)]))")
LONG="{\"customerId\":\"$KB\",\"issueDate\":\"2026-10-01\",\"items\":$ITEMS}"
AS POST "/api/v1/invoices?companyId=$C" "$LONG"; I=$(json_field "$BODY" id); NUM=$(json_field "$BODY" invoiceNumber)
SHORT="{\"customerId\":\"$KP\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Gürtel\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":40,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?companyId=$C" "$SHORT"; I2=$(json_field "$BODY" id)
fetch "/api/v1/invoices/$I/pdf?companyId=$C&format=pdf" "$WORK/long.pdf" > /dev/null
fetch "/api/v1/invoices/$I2/pdf?companyId=$C&format=pdf" "$WORK/short.pdf" > /dev/null

note "=== 1. the address in the window of a DL envelope (DIN 5008 Form B) ==="
assert_eq "written from 25 mm (was 17.6 mm)" "$(P "$WORK/long.pdf" "first('Beispiel Kunde AG')['x'], first('Ringstraße 22')['x']")" "25 25"
assert_eq "return address in the Vermerkzone, recipient in the Anschriftzone (62.7–90 mm)" \
  "$(P "$WORK/long.pdf" "(45 < next(r for r in pages[0] if ' · ' in r['s'] and r['s'].endswith('10115 Berlin'))['y'] < 62.7, first('Beispiel Kunde AG')['y'] - 11*0.3528*0.75 >= 62.7, first('80331 München')['y'] <= 90)")" "(True, True, True)"
assert_eq "the contact person below the business's name (was: none)" \
  "$(P "$WORK/long.pdf" "round(first('Frau Erika Mustermann')['y'] - first('Beispiel Kunde AG')['y'], 1), first('Frau Erika Mustermann')['x']")" "4.9 25"
assert_eq "…not repeated for a private customer" "$(pos "$WORK/short.pdf" | grep -o '"Max Privat"' | wc -l | tr -d ' ')" "1"
STREAM=$(python3 - "$WORK/short.pdf" <<'PY'
import re, sys, zlib
pdf = open(sys.argv[1], 'rb').read()
out = b''
# Tier 734b: up to „endstream“, the line end kept — `\r?\nendstream` took a compressed
# stream's last byte when it was 0x0D (1 in 256): zlib then failed and the file came out empty.
for m in re.finditer(rb'stream\r?\n(.*?)endstream', pdf, re.S):
    try: out += zlib.decompress(m.group(1))
    except Exception: pass
# PDFKit writes the page upside down (1 0 0 -1 0 842 cm): y as given, in pt
marks = [mm for mm in (105, 148.5, 210) if re.search(rb'11\.33\d* %s\d* m' % (b'%.2f' % (mm / 25.4 * 72))[:-1], out)]
print(marks)
PY
)
assert_eq "fold marks at 105 / 210 mm, the hole mark at 148.5 mm (was: none)" "$STREAM" "[105, 148.5, 210]"

note "=== 2. a long description: its row grows ==="
OVER=$(P "$WORK/long.pdf" "[i for i in range(1, 30) for p in range(len(pages)) if first(f'Position {i}: Ledertasche Modell',p) and first(f'Position {i+1}: Ledertasche Modell',p) and first(f'Position {i+1}: Ledertasche Modell',p)['y'] - first(f'Position {i}: Ledertasche Modell',p)['y'] < 12]")
assert_eq "two lines of text, the next row below both (was 8.5 mm apart — over the second line)" "$OVER" "[]"
assert_eq "…every row printed once" "$(pos "$WORK/long.pdf" | python3 -c "import json,sys,re;p=json.load(sys.stdin);print(sorted(int(m.group(1)) for pg in p for r in pg for m in [re.match(r'Position (\d+):', r['s'])] if m)==list(range(1,31)))")" "True"

note "=== 3. a following sheet names its invoice ==="
N=$(pages "$WORK/long.pdf")
assert_eq "more than one sheet" "$([ "$N" -ge 2 ] && echo yes)" "yes"
assert_eq "sheet 2: „Rechnung <Nr.> · <Kunde> · <Datum>“ above the table (was: only „Seite 2 von N“)" \
  "$(P "$WORK/long.pdf" "next((r['s'] for r in pages[1] if r['s'].startswith('Rechnung ')), '-'), next((r['y']<15 for r in pages[1] if r['s'].startswith('Rechnung ')), False)")" "Rechnung $NUM · Beispiel Kunde AG · 01.10.2026 True"
assert_eq "…not on the first" "$(P "$WORK/long.pdf" "any(r['s'].startswith('Rechnung $NUM ·') for r in pages[0])")" "False"
assert_eq "the bank details and the register details on every sheet (Tier 731b: on the last only)" \
  "$(P "$WORK/long.pdf" "[(any(r['s']=='IBAN: DE89370400440532013000' for r in pg), any(r['s'].startswith('Sitz der Gesellschaft') or r['s']=='Zahlungsinformationen:' for r in pg)) for pg in pages] == [(True, True)] * len(pages)")" "True"
assert_eq "…and every sheet's table ends above them" \
  "$(P "$WORK/long.pdf" "max(r['y'] for pg in pages for r in pg if r['s'].startswith('Position ') or r['s'].startswith('Modell')) < min(r['y'] for pg in pages for r in pg if r['s']=='Zahlungsinformationen:') - 3")" "True"

note "=== 4. printing many: one PDF ==="
PRINT="{\"invoiceIds\":[\"$I\",\"$I2\"]}"
CODE=$(curl -sS -o "$WORK/all.pdf" -w "%{http_code}" -X POST "$API/api/v1/invoices/bulk-print?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$PRINT")
assert_eq "one PDF of both, every sheet (there was only the ZIP)" "$CODE/$(head -c 4 "$WORK/all.pdf")/$(pages "$WORK/all.pdf")" "200/%PDF/$((N + 1))"
assert_eq "…printed at its actual size (Tier 731c: „fit to page“ shrinks it, the address leaves the window)" \
  "$(node -e "const L=require('pdf-lib');L.PDFDocument.load(require('fs').readFileSync(process.argv[1])).then(d=>console.log(String(d.catalog.lookup(L.PDFName.of('ViewerPreferences'))).replace(/\s+/g,' ')))" "$WORK/all.pdf")" "<< /PrintScaling /None >>"
FOREIGN="{\"invoiceIds\":[\"$I\"]}"
assert_eq "another company's invoice: 404" "$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/invoices/bulk-print?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" -H "Content-Type: application/json" -d "$FOREIGN")" "404"
AS POST "/api/v1/invoices/bulk-print?companyId=$C" '{"invoiceIds":[]}'
assert_eq "none chosen: 400" "$STATUS" "400"

summary
