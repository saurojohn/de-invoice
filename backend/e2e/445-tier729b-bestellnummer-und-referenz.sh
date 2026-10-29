#!/bin/bash
# Tier 729b — the customer's order number and reference on the invoice
#
# Measured on the invoice form: no field for „Ihre Bestellnummer“ or „Ihre
# Referenz“ — many businesses pay only an invoice that names their order.
# The XRechnung read invoice.buyerReference, a column that did not exist:
# BT-10 was the customer's name; BT-13 (the order) was never written.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-445-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier729b-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
kosit() { # file → ACCEPTABLE or the failed rules
  local out="$WORK/k-$(basename "$1")"; mkdir -p "$out"
  if (cd "$out" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$out" "$1" >/dev/null 2>&1); then echo ACCEPTABLE
  else echo "REJECT $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$out"/*.xml 2>/dev/null | head -3 | tr '\n' ' ')"; fi
}
cii_of() { python3 - "$1" <<'PY'
import re, sys, zlib
pdf = open(sys.argv[1], 'rb').read()
# Tier 734b: up to „endstream“, the line end kept — `\r?\nendstream` took a compressed
# stream's last byte when it was 0x0D (1 in 256): zlib then failed and the file came out empty.
for m in re.finditer(rb'stream\r?\n(.*?)endstream', pdf, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    if b'CrossIndustryInvoice' in data[:2000]:
        sys.stdout.write(data.decode('utf-8')); break
PY
}
el() { python3 -c "import re,sys,html;m=re.search(sys.argv[2], open(sys.argv[1],encoding='utf-8').read(), re.S);print(html.unescape(m.group(1)).strip() if m else '-')" "$1" "$2"; }

AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Werkstatt GmbH\",\"vatId\":\"DE123456789\",\"phone\":\"+49 30 1\",\"email\":\"info@werkstatt.example.test\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: the company" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k@example.test\"}}"
K=$(json_field "$BODY" id)
TODAY=$(TZ=Europe/Berlin date +%F)   # a draft can be changed on its issue day only
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"orderReference\":\" 4500012345 \",\"buyerReference\":\"Projekt Nord & Süd\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
assert_eq "kept, trimmed (there was no such field)" "$STATUS/$(json_field "$BODY" orderReference)/$(json_field "$BODY" buyerReference)" "201/4500012345/Projekt Nord & Süd"

note "=== 1. the PDF ==="
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/inv.pdf" > /dev/null
L=$(pdf_text "$WORK/inv.pdf" --lines | sed 's/\xc2\xa0/ /g')
assert_eq "„Ihre Bestellnr.“ and „Ihre Referenz“ in the details" \
  "$(echo "$L" | grep -c 'Ihre Bestellnr\.:')/$(echo "$L" | grep -c '4500012345')/$(echo "$L" | grep -c 'Ihre Referenz:')/$(echo "$L" | grep -c 'Projekt Nord & Süd')" "1/1/1/1"

note "=== 2. the XRechnung (UBL) ==="
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x.xml" > /dev/null
assert_eq "BT-10 the reference (was: the customer's name)" "$(el "$WORK/x.xml" '<cbc:BuyerReference>(.*?)</cbc:BuyerReference>')" "Projekt Nord & Süd"
assert_eq "BT-13 the order (was: none)" "$(el "$WORK/x.xml" '<cac:OrderReference>\s*<cbc:ID>(.*?)</cbc:ID>')" "4500012345"
assert_eq "KoSIT" "$(kosit "$WORK/x.xml")" "ACCEPTABLE"

note "=== 3. the ZUGFeRD XML (CII) ==="
fetch "/api/v1/invoices/$I/zugferd?companyId=$C" "$WORK/z.pdf" > /dev/null
cii_of "$WORK/z.pdf" > "$WORK/z.xml"
assert_eq "BT-10, BT-13" "$(el "$WORK/z.xml" '<ram:BuyerReference>(.*?)</ram:BuyerReference>')/$(el "$WORK/z.xml" '<ram:BuyerOrderReferencedDocument>\s*<ram:IssuerAssignedID>(.*?)</ram:IssuerAssignedID>')" "Projekt Nord & Süd/4500012345"
assert_eq "KoSIT" "$(kosit "$WORK/z.xml")" "ACCEPTABLE"

note "=== 4. changed, cleared, too long ==="
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"orderReference":"PO-77","buyerReference":""}'
assert_eq "changed; an emptied reference is none" "$STATUS/$(json_field "$BODY" orderReference)/$(json_field "$BODY" buyerReference)" "200/PO-77/"
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/x2.xml" > /dev/null
assert_eq "…BT-10 falls back as before (the customer's name)" "$(el "$WORK/x2.xml" '<cbc:BuyerReference>(.*?)</cbc:BuyerReference>')" "$TAG Kunde AG"
LONG=$(python3 -c "print('X'*101)")
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"orderReference\":\"$LONG\"}"
assert_eq "more than 100 characters: 400" "$STATUS" "400"

summary
