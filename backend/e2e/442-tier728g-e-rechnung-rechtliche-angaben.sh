#!/bin/bash
# Tier 728g — the e-invoice carries the company's register details (BT-33)
#
# Since 2025 the e-invoice is the invoice a business receives; its XML
# prevails over the PDF it may sit in. The PDF stated the seat, the register
# court and number, the managing directors and the other details (Tier 728);
# the XRechnung (UBL) and the ZUGFeRD XML (CII) carried the register number
# as an identifier (BT-30) and nothing else — BT-33 „Seller additional legal
# information“ was empty.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-442-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier728g-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS --max-time 180 -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
kosit() { # file → ACCEPTABLE or the failed rules
  local out="$WORK/k-$(basename "$1")"; mkdir -p "$out"
  if (cd "$out" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$out" "$1" >/dev/null 2>&1); then echo ACCEPTABLE
  else echo "REJECT $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$out"/*.xml 2>/dev/null | head -3 | tr '\n' ' ')"; fi
}
# the CII inside a ZUGFeRD PDF
cii_of() { python3 - "$1" <<'PY'
import re, sys, zlib
pdf = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', pdf, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    if b'CrossIndustryInvoice' in data[:2000]:
        sys.stdout.write(data.decode('utf-8')); break
PY
}
# the text of one element, entities decoded
el() { python3 -c "import re,sys,html;m=re.search(sys.argv[2], open(sys.argv[1],encoding='utf-8').read(), re.S);print(html.unescape(m.group(1)).strip() if m else '-')" "$1" "$2"; }

AS PUT "/api/v1/companies/$C?companyId=$C" "{\"name\":\"$TAG Werkstatt\",\"legalName\":\"$TAG Werkstatt Lederwaren GmbH\",\"rechtsform\":\"GmbH\",\"vatId\":\"DE123456789\",\"taxId\":\"12/345/67890\",\"phone\":\"+49 30 1234567\",\"email\":\"info@werkstatt.example.test\",\"registerEntry\":\"Amtsgericht Berlin-Charlottenburg, HRB 123456 B\",\"managingDirector\":\"Anna Beispiel & Bernd Muster\",\"otherInfo\":\"WEEE-Reg.-Nr. DE 12345678\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: the company's details" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k@example.test\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
WANT="Sitz der Gesellschaft: Berlin · Handelsregister: Amtsgericht Berlin-Charlottenburg, HRB 123456 B · Geschäftsführer: Anna Beispiel & Bernd Muster · WEEE-Reg.-Nr. DE 12345678"

note "=== 1. the XRechnung (UBL) ==="
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x.xml" > /dev/null
assert_eq "BT-33: seat, register, directors, other details (was: none)" \
  "$(el "$WORK/x.xml" '<cbc:CompanyLegalForm>(.*?)</cbc:CompanyLegalForm>')" "$WANT"
assert_eq "…the register number still as BT-30" "$(el "$WORK/x.xml" '<cac:PartyLegalEntity>.*?<cbc:CompanyID>(.*?)</cbc:CompanyID>')" "Amtsgericht Berlin-Charlottenburg, HRB 123456 B"
assert_eq "KoSIT (XSD, EN 16931, XRechnung)" "$(kosit "$WORK/x.xml")" "ACCEPTABLE"

note "=== 2. the ZUGFeRD PDF's XML (CII) ==="
fetch "/api/v1/invoices/$I/zugferd?companyId=$C" "$WORK/z.pdf" > /dev/null
cii_of "$WORK/z.pdf" > "$WORK/z.xml"
assert_eq "BT-33 as the seller's Description (was: none)" \
  "$(el "$WORK/z.xml" '<ram:SellerTradeParty>.*?<ram:Description>(.*?)</ram:Description>')" "$WANT"
assert_eq "KoSIT (CII, EN 16931)" "$(kosit "$WORK/z.xml")" "ACCEPTABLE"

note "=== 3. a sole trader without a register entry ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"registerEntry":"","managingDirector":"","otherInfo":""}'
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x2.xml" > /dev/null
assert_eq "nothing to state: no BT-33, no seat" "$(grep -c 'CompanyLegalForm\|Sitz der' "$WORK/x2.xml")" "0"

note "=== 4. why the settings ask for phone and e-mail (Tier 728h) ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"phone":""}'
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x3.xml" > /dev/null
assert_eq "without a phone number KoSIT rejects the XRechnung (BR-DE-6)" "$(kosit "$WORK/x3.xml" | grep -o 'REJECT\|BR-DE-6' | sort -u | tr '\n' ' ')" "BR-DE-6 REJECT "

summary
