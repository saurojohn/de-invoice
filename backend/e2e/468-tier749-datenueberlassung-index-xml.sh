#!/bin/bash
# Tier 749 — the data for the tax office's software, with index.xml
#
# § 147 Abs. 6 AO (Z3): the auditor's software reads a package described by the
# Beschreibungsstandard: index.xml names the tables, columns and types, the data
# are plain text files beside it. The GoBD export held none of that. Read here as
# that software would: the order of the elements, every row against its columns.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-468-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier749-e2e\",\"companyName\":\"Müller $TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
CUST='{"name":"Kunde; \"Spezial\" & Söhne","type":"business","address":{"street":"Ring 2","city":"Köln","postalCode":"50667","country":"DE"}}'
AS POST "/api/v1/customers?companyId=$C" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"2026-03-10\",\"items\":[{\"description\":\"Beratung\\nzweite Zeile\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19},{\"description\":\"Buch\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":50.5,\"vatRate\":0.07}]}"
AS POST "/api/v1/invoices?companyId=$C" "$INV"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
NUM=$(q "SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE id='$I';")
PAY='{"amount":100,"paymentDate":"2026-03-20","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "$PAY"
[[ "$STATUS" == 20* ]] && pass "fixture: an invoice in two rates, part paid" || fail "payment: $STATUS $BODY"
EXP="{\"description\":\"Einkauf\",\"invoiceDate\":\"2026-03-15\",\"invoiceNumber\":\"ER-$TAG\",\"taxLines\":[{\"vatRate\":0.19,\"netAmount\":100,\"vatAmount\":19},{\"vatRate\":0.07,\"netAmount\":10,\"vatAmount\":0.7}]}"
AS POST "/api/v1/expenses?companyId=$C" "$EXP"
assert_eq "fixture: an expense in two rates" "$STATUS" "201"
CASH='{"businessDate":"2026-03-12","type":"einnahme","amount":25.5,"description":"Barverkauf"}'
AS POST "/api/v1/cashbook/entries?companyId=$C" "$CASH"
assert_eq "fixture: a cash entry" "$STATUS" "201"
DRAFT="{\"customerId\":\"$K\",\"issueDate\":\"2026-03-11\",\"items\":[{\"description\":\"Entwurf\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":999,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?companyId=$C" "$DRAFT"
curl -sS -o "$D/y.zip" -w '' "$API/api/v1/gobd-export?companyId=$C&year=2026" -H "x-user-id: $U" -H "x-company-id: $C"
curl -sS -o "$D/m.zip" -w '' "$API/api/v1/gobd-export?companyId=$C&year=2026&month=4" -H "x-user-id: $U" -H "x-company-id: $C"

note "=== 1. index.xml, element by element ==="
RESULT=$(python3 -I - "$D/y.zip" "$NUM" <<'PY'
import csv, io, json, re, sys, zipfile
import xml.etree.ElementTree as ET
zip_path, number = sys.argv[1:3]
z = zipfile.ZipFile(zip_path)
base = 'datenueberlassung/'
raw = z.read(base + 'index.xml').decode('utf-8')
out = {}
out['doctype'] = 'DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd"' in raw
root = ET.fromstring(raw)
tags = lambda e: [c.tag for c in e]
ordered = lambda seen, order: [order.index(t) for t in seen] == sorted(order.index(t) for t in seen)
out['root'] = (root.tag, tags(root))
out['supplier'] = tags(root.find('DataSupplier'))
media = root.find('Media')
out['media_first'] = tags(media)[0]
TABLE = ['URL', 'Name', 'Description', 'Validity', 'ANSI', 'Macintosh', 'OEM', 'UTF16', 'UTF7', 'UTF8', 'DecimalSymbol', 'DigitGroupingSymbol', 'SkipNumBytes', 'Range', 'Epoch', 'VariableLength', 'FixedLength']
VARLEN = ['ColumnDelimiter', 'RecordDelimiter', 'TextEncapsulator', 'VariablePrimaryKey', 'VariableColumn', 'ForeignKey']
problems, counts = [], {}
tables = media.findall('Table')
names = {t.find('Name').text for t in tables}
for t in tables:
    url, name = t.find('URL').text, t.find('Name').text
    if not ordered(tags(t), TABLE): problems.append(f'{name}: order of Table {tags(t)}')
    vl = t.find('VariableLength')
    if not ordered(tags(vl), VARLEN): problems.append(f'{name}: order of VariableLength')
    if t.find('Validity/Range/From') is None: problems.append(f'{name}: no Validity')
    cols = []
    for c in vl:
        if c.tag in ('VariablePrimaryKey', 'VariableColumn'):
            kind = [k for k in c if k.tag in ('Numeric', 'AlphaNumeric', 'Date')]
            if len(kind) != 1 or tags(c)[0] != 'Name': problems.append(f'{name}: column {c.find("Name").text}')
            acc = kind[0].find('Accuracy')
            cols.append((c.find('Name').text, kind[0].tag, int(acc.text) if acc is not None else None))
    fk = vl.find('ForeignKey')
    if fk is not None:
        if fk.find('References').text not in names: problems.append(f'{name}: FK to nowhere')
        if not {n.text for n in fk.findall('Name')} <= {c[0] for c in cols}: problems.append(f'{name}: FK on no column')
    if base + url not in z.namelist():
        problems.append(f'{name}: no file {url}')
        continue
    data = z.read(base + url)
    text = data.decode('utf-8')
    if text and (not text.endswith('\r\n') or re.search(r'(?<!\r)\n', text)): problems.append(f'{name}: not CRLF')
    rows = list(csv.reader(io.StringIO(text, newline=''), delimiter=';', quotechar='"'))
    counts[name] = len(rows)
    keys = set()
    n_keys = len([c for c in vl if c.tag == 'VariablePrimaryKey'])
    for r in rows:
        if len(r) != len(cols):
            problems.append(f'{name}: {len(r)} cells, {len(cols)} columns: {r}')
            continue
        k = tuple(r[:n_keys])
        if k in keys: problems.append(f'{name}: key twice {k}')
        keys.add(k)
        for v, (cn, kind, acc) in zip(r, cols):
            if not v: continue
            if kind == 'Numeric' and not re.fullmatch(r'-?\d+,\d{%d}' % acc, v): problems.append(f'{name}.{cn}: {v!r}')
            if kind == 'Date' and not re.fullmatch(r'\d{2}\.\d{2}\.\d{4}', v): problems.append(f'{name}.{cn}: {v!r}')
out['tables'] = len(tables)
out['problems'] = problems[:6]
out['counts'] = counts
def rows(f):
    return list(csv.reader(io.StringIO(z.read(base + f).decode('utf-8'), newline=''), delimiter=';', quotechar='"'))
out['invoices'] = [r[0] for r in rows('rechnungen.csv')]
out['invoice'] = rows('rechnungen.csv')[0][7:10]
out['customer'] = rows('kunden.csv')[0][3]
out['positions'] = [(r[1], r[2], r[3]) for r in rows('rechnungspositionen.csv')]
out['payment'] = [(r[1], r[2], r[3]) for r in rows('zahlungen.csv')]
out['expense'] = [(r[6 + 1], r[9 + 1]) for r in rows('ausgaben.csv')]
out['lines'] = sorted((r[1], r[2]) for r in rows('ausgaben_steuerzeilen.csv'))
out['cash'] = [(r[1], r[4]) for r in rows('kassenbuch.csv')]
report = json.loads(z.read('verification-report.json'))
out['manifest'] = base + 'index.xml' in [f['path'] for f in json.loads(z.read('manifest.json'))['files']]
out['dtd'] = report['summary']['datenueberlassung']['dtd']
out['hint'] = 'hint' in report['summary']['datenueberlassung']
print(json.dumps(out, ensure_ascii=False))
PY
)
J() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$RESULT" "$1"; }
[[ -n "$RESULT" ]] && pass "the package was read" || { fail "the package could not be read"; summary; exit 1; }
assert_eq "the DOCTYPE names the DTD" "$(J "d['doctype']")" "True"
assert_eq "DataSet: Version, DataSupplier, Media" "$(J "d['root']")" "['DataSet', ['Version', 'DataSupplier', 'Media']]"
assert_eq "DataSupplier: Name, Location, Comment" "$(J "d['supplier']")" "['Name', 'Location', 'Comment']"
assert_eq "Media starts with its Name" "$(J "d['media_first']")" "Name"
assert_eq "ten tables" "$(J "d['tables']")" "10"
assert_eq "no problem: order, columns, keys, numbers, dates, line ends" "$(J "d['problems']")" "[]"
assert_eq "the manifest has index.xml" "$(J "d['manifest']")" "True"

note "=== 2. what is in the tables ==="
assert_eq "only the issued invoice, not the draft" "$(J "d['invoices']")" "['$NUM']"
assert_eq "its amounts, decimal comma: 250,50 + 41,54 = 292,04" "$(J "d['invoice']")" "['250,50', '41,54', '292,04']"
assert_eq "text with ; \" & and an umlaut comes through" "$(J "d['customer']")" 'Kunde; "Spezial" & Söhne'
assert_eq "its positions; a line break in a text is a space, not a new row" \
  "$(J "d['positions']")" "[['1', 'Beratung zweite Zeile', '2,0000'], ['2', 'Buch', '1,0000']]"
assert_eq "the payment names its invoice" "$(J "d['payment']")" "[['$NUM', '20.03.2026', '100,00']]"
assert_eq "the expense" "$(J "d['expense']")" "[['110,00', '129,70']]"
assert_eq "its lines per rate" "$(J "d['lines']")" "[['0,0700', '10,00'], ['0,1900', '100,00']]"
assert_eq "the cash book" "$(J "d['cash']")" "[['12.03.2026', '25,50']]"
[[ "$(J "d['counts']['Buchungen']")" -ge 3 ]] && pass "the journal has the bookings ($(J "d['counts']['Buchungen']"))" || fail "journal: $(J "d['counts']")"

note "=== 3. a month holds its month ==="
assert_eq "April: no invoice" "$(python3 -I -c "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('datenueberlassung/rechnungen.csv'))" "$D/m.zip")" "b''"

note "=== 4. the DTD ==="
if [[ -f "$SCRIPT_DIR/../assets/gdpdu-01-09-2004.dtd" ]]; then
  assert_eq "it lies beside index.xml" "$(J "(d['dtd'], d['hint'])")" "('gdpdu-01-09-2004.dtd', False)"
  if command -v xmllint >/dev/null; then
    mkdir "$D/x"; (cd "$D/x" && python3 -I -c "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall('.')" "$D/y.zip")
    xmllint --noout --valid "$D/x/datenueberlassung/index.xml" 2>"$D/lint" && pass "index.xml is valid against the DTD" || fail "xmllint: $(head -3 "$D/lint")"
  fi
else
  assert_eq "not in this installation: the report says so" "$(J "(d['dtd'], d['hint'])")" "(None, True)"
fi

summary
