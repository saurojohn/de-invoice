#!/bin/bash
# Tier 693 — the ZUGFeRD invoice is a real PDF/A-3, and the XML can be found
#
# Measured before with Mustang 2.26 (the ZUGFeRD reference validator, veraPDF
# inside): PDF invalid, XML invalid — "XMP Metadata not found", "XML could not
# be extracted". The XMP said "PDF/A-3B" all the same. Behind it:
#   - the XMP stream sat inline in the catalog (a stream must be indirect),
#     and named Factur-X properties without their extension schema (6.6.2.3);
#   - the attachment was application/vnd.cef.factur-x+xml (Factur-X: text/xml),
#     /AFRelationship an array [Source Data] (one name: Alternative);
#   - no OutputIntent — 71 uses of DeviceRGB / DeviceGray failed (6.2.4.3);
#   - the fonts were not embedded (6.2.11.4: Helvetica, Helvetica-Bold).
# Now: Liberation Sans / Serif / Mono embedded under the standard names (the
# same metrics), an sRGB OutputIntent, the XMP as Factur-X 1.0 writes it, Info
# and XMP alike. Mustang: PDF valid, XML valid.
#
# The structure is checked here; with MUSTANG_JAR set (the validator is not
# in the repository) the whole validation runs as well.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-417-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier693-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t693.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde AG","type":"business","vatId":"DE987654321","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"k@example.test"}}'
K=$(P "d['id']")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"skontoPercent\":2,\"skontoDays\":10,\"items\":[{\"description\":\"Beratung äöü ß €\",\"quantity\":3,\"unit\":\"Std\",\"unitPrice\":120,\"vatRate\":0.19},{\"description\":\"Fachbuch\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":40,\"vatRate\":0.07}]}"
I=$(P "d['id']"); NUM=$(P "d['invoiceNumber']")
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an issued invoice" "$STATUS" "200"
curl -sS -o "$WORK/z.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/zugferd?companyId=$C"

note "=== 1. the structure PDF/A-3 and Factur-X ask for ==="
python3 - "$WORK/z.pdf" "$NUM" > "$WORK/facts.txt" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); num = sys.argv[2]
objs = {int(m.group(1)): m.group(2) for m in re.finditer(rb'(\d+) 0 obj\s*(.*?)endobj', d, re.S)}
def body(n): return objs.get(n, b'')
catalog = next((o for o in objs.values() if b'/Type /Catalog' in o), b'')
def ref(dct, key):
    m = re.search(rb'/' + key + rb'\s+(\d+) 0 R', dct); return int(m.group(1)) if m else None
facts = []
# fonts: every font of the pages embedded, none of the standard 14
fonts = [o for o in objs.values() if b'/Type /Font' in o]
std = [o for o in fonts if re.search(rb'/BaseFont /(Helvetica|Times|Courier|Symbol|ZapfDingbats)', o)]
desc = [o for o in objs.values() if b'/Type /FontDescriptor' in o]
facts.append('fonts %d standard %d descriptors-with-program %d/%d' % (len(fonts), len(std), sum(b'/FontFile2' in o for o in desc), len(desc)))
# OutputIntent
oi = re.search(rb'/OutputIntents\s*\[\s*(\d+) 0 R', catalog)
oid = body(int(oi.group(1))) if oi else b''
icc = ref(oid, rb'DestOutputProfile')
facts.append('outputintent %s %s icc %s' % (b'/S /GTS_PDFA1' in oid, b'sRGB' in oid, icc is not None and b'/N 3' in body(icc)))
# XMP: indirect, unfiltered, PDF/A-3B, the Factur-X extension schema
meta = ref(catalog, rb'Metadata')
mb = body(meta) if meta else b''
facts.append('xmp indirect %s unfiltered %s part3B %s extension %s level %s' % (
    meta is not None, b'/Filter' not in mb.split(b'stream')[0],
    b'<pdfaid:part>3</pdfaid:part>' in mb and b'<pdfaid:conformance>B</pdfaid:conformance>' in mb,
    b'<pdfaSchema:prefix>fx</pdfaSchema:prefix>' in mb and b'<pdfaProperty:name>ConformanceLevel</pdfaProperty:name>' in mb,
    (re.search(rb'<fx:ConformanceLevel>([^<]*)<', mb) or [b'', b'-'])[1].decode()))
# the attachment
fs = next((o for o in objs.values() if b'/Type /Filespec' in o), b'')
ef = ref(fs, rb'F') if b'/EF' in fs else None
emb = next((o for o in objs.values() if b'/Type /EmbeddedFile' in o), b'')
facts.append('attachment %s mime %s relationship %s' % (b'(factur-x.xml)' in fs or b'factur-x.xml' in fs.replace(b'\x00', b''), b'/Subtype /text#2Fxml' in emb, (re.search(rb'/AFRelationship\s*(/\w+|\[)', fs) or [b'', b'-'])[1].decode()))
af = re.search(rb'/AF\s*\[\s*\d+ 0 R\s*\]', catalog)
facts.append('catalog AF %s' % bool(af))
# Info and XMP alike
info_m = re.search(rb'/Info\s+(\d+) 0 R', d)
info = body(int(info_m.group(1))) if info_m else b''
def info_str(key):
    m = re.search(rb'/' + key + rb'\s*\(([^)]*)\)', info)
    if m: return m.group(1).decode('latin-1')
    m = re.search(rb'/' + key + rb'\s*<([0-9A-Fa-f]+)>', info)
    if m:
        raw = bytes.fromhex(m.group(1).decode())
        return raw[2:].decode('utf-16-be') if raw[:2] == b'\xfe\xff' else raw.decode('latin-1')
    return None
producer = re.search(rb'<pdf:Producer>([^<]*)<', mb)
facts.append('producer alike %s' % (producer is not None and info_str(rb'Producer') == producer.group(1).decode()))
facts.append('title %s' % info_str(rb'Title'))
print('\n'.join(facts))
PY
cat "$WORK/facts.txt" | sed 's/^/  /'
F() { grep "^$1" "$WORK/facts.txt"; }
assert_eq "every font embedded, none of the standard 14 (was: Helvetica, Helvetica-Bold not embedded)" "$(F fonts | awk '{print $4, ($6 == $6)}' ) $(F fonts | awk '{split($6, a, "/"); print (a[1] == a[2] && a[2] > 0)}')" "0 1 1"
assert_eq "an sRGB OutputIntent with its ICC profile (was: none)" "$(F outputintent)" "outputintent True True icc True"
assert_eq "the XMP: an indirect, unfiltered stream, PDF/A-3B, with the Factur-X extension schema (was: inline, no schema)" "$(F xmp)" "xmp indirect True unfiltered True part3B True extension True level EN 16931"
assert_eq "the XML: factur-x.xml, text/xml, Alternative (was: vnd.cef…, [Source Data])" "$(F attachment)" "attachment True mime True relationship /Alternative"
assert_eq "…and named in the catalog's /AF" "$(F catalog)" "catalog AF True"
assert_eq "Info and XMP say the same producer" "$(F producer)" "producer alike True"
assert_eq "the title is the invoice" "$(F title)" "title Rechnung $NUM"

note "=== 2. the text is the same text ==="
T=$(pdf_text "$WORK/z.pdf")
assert_eq "the umlauts, ß and € of the line, the totals, one page" \
  "$(grep -c 'Beratung äöü ß €' <<<"$T") $(grep -c 'Gesamtbetrag:' <<<"$T") $(grep -c 'Seite 1 von 1' <<<"$T")" "1 1 1"

note "=== 3. the reference validator (with MUSTANG_JAR) ==="
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
[[ -x "$JAVA_BIN" ]] || JAVA_BIN=$(command -v java || true)
if [[ -n "${MUSTANG_JAR:-}" && -f "$MUSTANG_JAR" && -n "$JAVA_BIN" ]]; then
  (cd "$WORK" && "$JAVA_BIN" -jar "$MUSTANG_JAR" --action validate --source "$WORK/z.pdf" --disable-file-logging > "$WORK/report.xml" 2> "$WORK/report.err")
  assert_eq "Mustang: PDF valid, XML valid (was: invalid, „XML could not be extracted“)" \
    "$(python3 -c "import re,sys; x=open(sys.argv[1],encoding='utf-8',errors='ignore').read(); print(' '.join(re.findall(r'<summary status=\"([a-z]+)\"', x)[:3]))" "$WORK/report.xml")" "valid valid valid"
else
  note "MUSTANG_JAR not set — the reference validation is not run here (the structure above is)"
fi

summary
